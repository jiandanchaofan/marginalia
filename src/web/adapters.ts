/**
 * Site adapters: normalise a fetched page before Readability runs, and collect metadata
 * that Readability doesn't see (WeChat keeps the author and publish time outside the article).
 */

export interface SiteMeta {
  title?: string;
  author?: string;
  siteName?: string;
  publishedAt?: number;
  excerpt?: string;
}

const LAZY_ATTRS = ["data-src", "data-original", "data-actualsrc", "data-lazy-src", "data-url", "data-echo", "data-croporisrc"];
const PLACEHOLDER = /^data:|placeholder|blank\.|loading|lazy|spacer|pixel\.gif/i;

const metaContent = (doc: Document, ...selectors: string[]) => {
  for (const s of selectors) {
    const v = doc.querySelector(s)?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
};

const parseDate = (v?: string | null) => {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

/** Pick the largest candidate from a srcset. */
function bestFromSrcset(srcset: string) {
  let best = "";
  let bestW = -1;
  for (const part of srcset.split(",")) {
    const [u, d] = part.trim().split(/\s+/);
    const w = d ? parseFloat(d) : 1;
    if (u && w > bestW) {
      best = u;
      bestW = w;
    }
  }
  return best;
}

export const isWeixin = (url: string) => /(^|\.)mp\.weixin\.qq\.com$/i.test(new URL(url).hostname);
/** WeChat's image CDN rejects foreign referers; it serves fine with none. */
export const noReferer = (imgUrl: string) => /(^|\.)(qpic\.cn|qlogo\.cn)$/i.test(new URL(imgUrl).hostname);

export function prepareDocument(doc: Document, url: string): SiteMeta {
  // Lazy-loaded images → real src.
  doc.querySelectorAll("img").forEach((img) => {
    const cur = img.getAttribute("src") ?? "";
    const lazy = LAZY_ATTRS.map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith("data:"));
    if (lazy && (!cur || PLACEHOLDER.test(cur))) img.setAttribute("src", lazy);
    const set = img.getAttribute("data-srcset") ?? img.getAttribute("srcset");
    if (set && (!img.getAttribute("src") || PLACEHOLDER.test(img.getAttribute("src")!))) img.setAttribute("src", bestFromSrcset(set));
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
  });
  // <noscript><img></noscript> fallbacks used by some lazy loaders.
  doc.querySelectorAll("noscript").forEach((ns) => {
    if (/<img/i.test(ns.textContent ?? "")) {
      const holder = doc.createElement("div");
      holder.innerHTML = ns.textContent ?? "";
      ns.replaceWith(...Array.from(holder.childNodes));
    }
  });

  const meta: SiteMeta = {
    title: metaContent(doc, 'meta[property="og:title"]', 'meta[name="twitter:title"]'),
    author: metaContent(doc, 'meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]'),
    siteName: metaContent(doc, 'meta[property="og:site_name"]', 'meta[name="application-name"]'),
    publishedAt: parseDate(
      metaContent(doc, 'meta[property="article:published_time"]', 'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="date"]', 'meta[itemprop="datePublished"]') ??
        doc.querySelector("time[datetime]")?.getAttribute("datetime"),
    ),
    excerpt: metaContent(doc, 'meta[property="og:description"]', 'meta[name="description"]'),
  };

  if (isWeixin(url)) {
    const body = doc.querySelector("#js_content");
    body?.removeAttribute("style"); // starts hidden until their JS runs
    const account = doc.querySelector("#js_name")?.textContent?.trim();
    const author = doc.querySelector("#js_author_name, .rich_media_meta_text")?.textContent?.trim();
    const title = doc.querySelector("#activity-name")?.textContent?.trim();
    const scripts = Array.from(doc.scripts)
      .map((s) => s.textContent ?? "")
      .join("\n");
    const ct = /\bvar\s+ct\s*=\s*["']?(\d{9,11})/.exec(scripts)?.[1] ?? /create_time\s*[:=]\s*["']?(\d{9,11})/.exec(scripts)?.[1];
    meta.title = title || meta.title;
    meta.author = author || account || meta.author;
    meta.siteName = account ? `公众号 · ${account}` : "微信公众号";
    if (ct) meta.publishedAt = Number(ct) * 1000;
  }
  return meta;
}
