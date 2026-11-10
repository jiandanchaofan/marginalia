import { feedsApi, feedsChanged, type Source } from "./api";
import { fetchPage } from "../platform";
import { boilerplate, firstParagraph, paragraphs } from "./summary";

const MIN = 60_000;
const RETENTION_DAYS = 90;

/**
 * Some feeds publish links on a host that doesn't resolve (e.g. a mis-configured CDN domain) while the same
 * path works on the feed's own site. Probe such foreign hosts once per session and rewrite when that's the case.
 */
const hostVerdict = new Map<string, string | null>(); // foreign origin → replacement origin (null = keep)
async function repairLinks<T extends { url: string }>(items: T[], feedUrl: string, siteUrl: string): Promise<T[]> {
  const home = new URL(siteUrl || feedUrl).origin;
  const feedOrigin = new URL(feedUrl).origin;
  const foreign = [...new Set(items.map((i) => new URL(i.url).origin).filter((o) => o !== home && o !== feedOrigin))];
  for (const origin of foreign) {
    if (hostVerdict.has(origin)) continue;
    const sample = items.find((i) => new URL(i.url).origin === origin)!;
    let verdict: string | null = null;
    try {
      await fetchPage(sample.url);
    } catch (e) {
      if (/无法连接|超时|网络错误/.test(String(e instanceof Error ? e.message : e))) {
        for (const alt of [...new Set([feedOrigin, home])]) {
          const u = new URL(sample.url);
          try {
            await fetchPage(`${alt}${u.pathname}${u.search}`);
            verdict = alt;
            break;
          } catch {
            /* try next */
          }
        }
      }
    }
    hostVerdict.set(origin, verdict);
  }
  return items.map((i) => {
    const u = new URL(i.url);
    const alt = hostVerdict.get(u.origin);
    return alt ? { ...i, url: `${alt}${u.pathname}${u.search}${u.hash}` } : i;
  });
}

/** Fetch one source, extract first paragraphs, store new items and the conditional-GET validators. */
export async function refreshSource(src: Source, force = false): Promise<{ added: number; error?: string }> {
  const now = Date.now();
  try {
    const r = await feedsApi.fetch(src.feedUrl, force ? null : src.etag, force ? null : src.lastModified);
    if (r.notModified) {
      await feedsApi.saveSource({ ...src, lastFetched: now, lastError: null, errorCount: 0 });
      return { added: 0 };
    }
    const paras = r.items.map((i) => paragraphs(i.html));
    const boiler = boilerplate(paras);
    const items = await repairLinks(
      r.items.map((i, k) => ({ url: i.url, title: i.title, author: i.author, publishedAt: i.publishedAt, summary: firstParagraph(paras[k], boiler, i.title), image: i.image })),
      src.feedUrl,
      src.siteUrl || r.siteUrl,
    );
    const added = await feedsApi.upsert(src.id, items);
    await feedsApi.saveSource({
      ...src,
      title: src.title || r.title,
      siteUrl: src.siteUrl || r.siteUrl,
      etag: r.etag ?? null,
      lastModified: r.lastModified ?? null,
      lastFetched: now,
      lastError: null,
      errorCount: 0,
    });
    return { added };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await feedsApi.saveSource({ ...src, lastFetched: now, lastError: error, errorCount: src.errorCount + 1 }).catch(() => {});
    return { added: 0, error };
  }
}

/** Back off failing sources: 30 min, 1 h, 2 h … capped at a day. */
const due = (s: Source, intervalMin: number) => {
  if (!s.lastFetched) return true;
  const wait = s.errorCount ? Math.min(24 * 60, 30 * 2 ** (s.errorCount - 1)) : intervalMin;
  return Date.now() - s.lastFetched >= wait * MIN - 5_000;
};

let running: Promise<{ added: number; failed: number }> | null = null;

export function refreshAll(opts: { force?: boolean; intervalMin?: number; onProgress?(done: number, total: number): void } = {}) {
  if (running) return running;
  running = (async () => {
    const sources = (await feedsApi.sources()).filter((s) => s.kind !== "manual" && (opts.force || due(s, opts.intervalMin ?? 30)));
    let done = 0;
    let added = 0;
    let failed = 0;
    opts.onProgress?.(0, sources.length);
    const queue = [...sources];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          const r = await refreshSource(s, opts.force);
          added += r.added;
          if (r.error) failed++;
          opts.onProgress?.(++done, sources.length);
          feedsChanged();
        }
      }),
    );
    await feedsApi.prune(Date.now() - RETENTION_DAYS * 24 * 60 * MIN).catch(() => {});
    feedsChanged();
    return { added, failed };
  })().finally(() => {
    running = null;
  });
  return running;
}
