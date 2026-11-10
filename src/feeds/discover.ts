import { fetchPage } from "../platform";
import { feedsApi, type FetchResult, type Source } from "./api";

export interface Discovered {
  input: string;
  feedUrl: string;
  kind: Source["kind"];
  title: string;
  siteUrl: string;
  count: number;
  latest: { title: string; publishedAt: number }[];
}

const withScheme = (s: string) => (/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://${s.trim()}`);

async function tryFeed(url: string): Promise<FetchResult | null> {
  try {
    const r = await feedsApi.fetch(url);
    return r.items.length || r.title ? r : null;
  } catch {
    return null;
  }
}

const describe = (input: string, feedUrl: string, r: FetchResult, fallbackTitle = ""): Discovered => ({
  input,
  feedUrl,
  kind: r.kind,
  title: r.title || fallbackTitle || new URL(feedUrl).hostname,
  siteUrl: r.siteUrl || input,
  count: r.items.length,
  latest: [...r.items]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 3)
    .map((i) => ({ title: i.title, publishedAt: i.publishedAt })),
});

/**
 * Find the feed behind a site URL:
 * the URL itself → <link rel="alternate"> on the page → common feed paths (WordPress, Hugo, Jekyll, Substack…).
 * WeChat 合集 links are handled natively by the fetcher.
 */
export async function discover(raw: string): Promise<Discovered> {
  const input = withScheme(raw);
  const u = new URL(input);
  if (u.hostname === "mp.weixin.qq.com" && !u.pathname.startsWith("/mp/appmsgalbum")) {
    throw new Error("这是单篇公众号文章。订阅公众号请粘贴它的「合集」链接；单篇可用「探索」页的「添加网文」。");
  }

  const direct = await tryFeed(input);
  if (direct) return describe(input, input, direct);

  let pageTitle = "";
  const candidates: string[] = [];
  try {
    const page = await fetchPage(input);
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    pageTitle = (doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || doc.title || "").trim();
    doc.querySelectorAll('link[rel~="alternate"]').forEach((l) => {
      const type = (l.getAttribute("type") ?? "").toLowerCase();
      const href = l.getAttribute("href");
      const title = l.getAttribute("title") ?? "";
      if (!href || !/(rss|atom|feed\+json|json)/.test(type) || /comment|评论/i.test(title + href)) return;
      candidates.push(new URL(href, page.finalUrl).href);
    });
    const final = new URL(page.finalUrl);
    const dir = final.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
    candidates.push(`${dir}feed`, `${dir}feed/`, `${dir}rss`, `${dir}index.php/feed/`);
  } catch {
    /* page itself unreachable — still try the usual paths below */
  }
  for (const p of ["/feed", "/feed/", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/index.php/feed/"]) candidates.push(`${u.origin}${p}`);

  for (const c of [...new Set(candidates)]) {
    const r = await tryFeed(c);
    if (r && r.items.length) return describe(input, c, r, pageTitle);
  }
  throw new Error("没有找到这个网站的订阅源（RSS / Atom）。");
}
