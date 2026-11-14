import { Readability } from "@mozilla/readability";
import { sanitize } from "../core/formats/flow";
import { articleLookup, fetchImage, fetchPage, saveArticle, type SavedArticle } from "../platform";
import { noReferer, prepareDocument, type SiteMeta } from "./adapters";
import { t } from "../i18n";

export type ClipStage = "check" | "fetch" | "extract" | "images" | "save";
export interface ClipProgress {
  stage: ClipStage;
  done?: number;
  total?: number;
}

export interface ArticleMeta {
  title: string;
  author: string;
  siteName: string;
  publishedAt?: number;
  excerpt: string;
  sourceUrl: string;
}

export interface ClipResult extends SavedArticle {
  /** null when the article was already saved (metadata lives in the library / snapshot). */
  meta: ArticleMeta | null;
  imagesFailed: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

// Pages fetched recently (e.g. by the in-app preview) are reused when the article is then saved.
const pageCache = new Map<string, { page: { finalUrl: string; html: string }; at: number }>();
export async function getPage(url: string) {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.page;
  const page = await fetchPage(url);
  pageCache.set(url, { page, at: Date.now() });
  if (pageCache.size > 30) pageCache.delete(pageCache.keys().next().value!);
  return page;
}

export interface Readable {
  /** Sanitized article body with absolute image/link URLs (images still remote). */
  holder: HTMLDivElement;
  meta: Omit<ArticleMeta, "sourceUrl">;
  lang: string;
}

/** Site adapter + Readability on a fetched page. Shared by clipping and the in-app preview. */
export function extractReadable(page: { finalUrl: string; html: string }, hints: ClipHints = {}): Readable {
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  const base = doc.createElement("base");
  base.href = page.finalUrl; // Readability resolves relative links/images against baseURI
  doc.head.prepend(base);
  const site: SiteMeta = prepareDocument(doc, page.finalUrl);
  const lang = doc.documentElement.lang || "zh-CN";
  const docTitle = doc.title;
  const article = new Readability(doc, { charThreshold: 200, keepClasses: false }).parse();
  if (!article?.content || (article.textContent ?? "").trim().length < 60) {
    throw new Error(t("err.noContent"));
  }
  const holder = document.createElement("div");
  holder.appendChild(sanitize(article.content));
  holder.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    try {
      if (src && !src.startsWith("data:")) img.setAttribute("src", new URL(src, page.finalUrl).href);
    } catch {
      img.remove();
    }
  });
  holder.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href")!;
    if (href.startsWith("#")) return;
    try {
      a.setAttribute("href", new URL(href, page.finalUrl).href);
    } catch {
      a.removeAttribute("href");
    }
  });
  const siteName = (hints.siteName || site.siteName || article.siteName || new URL(page.finalUrl).hostname.replace(/^www\./, "")).trim();
  return {
    holder,
    lang: article.lang || lang,
    meta: {
      title: hints.title?.trim() || stripSiteSuffix((site.title || article.title || docTitle || new URL(page.finalUrl).hostname).trim(), siteName),
      author: (site.author || article.byline || "").trim(),
      siteName,
      publishedAt: site.publishedAt ?? (article.publishedTime ? Date.parse(article.publishedTime) || undefined : undefined),
      excerpt: (site.excerpt || article.excerpt || "").trim().slice(0, 300),
    },
  };
}

/**
 * URL → offline snapshot: fetch (Rust, no CORS) → site adapter → Readability → inline images as
 * data URIs → store. The snapshot is plain HTML with `marginalia:*` meta tags and one <article>.
 */
/** Known-good metadata from elsewhere (e.g. a feed item's clean title and its source's name). */
export interface ClipHints {
  title?: string;
  siteName?: string;
}

export async function clipArticle(rawUrl: string, onProgress: (p: ClipProgress) => void, hints: ClipHints = {}): Promise<ClipResult> {
  const url = rawUrl.trim();
  onProgress({ stage: "check" });
  const existing = await articleLookup(url);
  if (existing) return { id: existing, ext: "html", fileName: "", size: 0, existed: true, meta: null, imagesFailed: 0 };

  onProgress({ stage: "fetch" });
  const page = await getPage(url);

  onProgress({ stage: "extract" });
  const { holder, meta: base, lang } = extractReadable(page, hints);

  // Inline images so the article survives the site changing or disappearing.
  const imgs = Array.from(holder.querySelectorAll("img")).filter((i) => /^https?:/.test(i.getAttribute("src") ?? ""));
  const unique = [...new Set(imgs.map((i) => i.getAttribute("src")!))];
  const inlined = new Map<string, string>();
  let done = 0;
  let failed = 0;
  onProgress({ stage: "images", done, total: unique.length });
  await pool(unique, 6, async (src) => {
    try {
      inlined.set(src, await fetchImage(src, noReferer(src) ? undefined : page.finalUrl));
    } catch {
      failed++;
    }
    onProgress({ stage: "images", done: ++done, total: unique.length });
  });
  imgs.forEach((img) => {
    const data = inlined.get(img.getAttribute("src")!);
    if (data) img.setAttribute("src", data);
    else img.setAttribute("referrerpolicy", "no-referrer"); // still try online
  });

  const meta: ArticleMeta = { ...base, sourceUrl: url };
  onProgress({ stage: "save" });
  const head = [
    `<meta charset="utf-8">`,
    `<title>${esc(meta.title)}</title>`,
    `<meta name="marginalia:source" content="${esc(url)}">`,
    `<meta name="marginalia:final" content="${esc(page.finalUrl)}">`,
    `<meta name="marginalia:site" content="${esc(meta.siteName)}">`,
    `<meta name="marginalia:author" content="${esc(meta.author)}">`,
    meta.publishedAt ? `<meta name="marginalia:published" content="${new Date(meta.publishedAt).toISOString()}">` : "",
    `<meta name="marginalia:clipped" content="${new Date().toISOString()}">`,
    `<meta name="marginalia:excerpt" content="${esc(meta.excerpt)}">`,
  ].join("\n");
  const html = `<!doctype html>\n<html lang="${esc(lang)}">\n<head>\n${head}\n</head>\n<body>\n<article>\n${holder.innerHTML}\n</article>\n</body>\n</html>\n`;
  const saved = await saveArticle(url, html);
  return { ...saved, meta, imagesFailed: failed };
}

/** "文章标题 – 站点名" / "Title | Site" → "文章标题". */
export function stripSiteSuffix(title: string, site: string) {
  if (!site) return title;
  const esc = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = title.replace(new RegExp(`\\s*[-–—|·:：_]\\s*${esc}\\s*$`), "").trim();
  return t || title;
}

export const looksLikeUrl = (s: string) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(s.trim());
