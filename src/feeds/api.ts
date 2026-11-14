/** Subscriptions bridge (desktop only: fetching other sites needs the native HTTP client). */
import { useEffect, useState } from "react";
import { isTauri } from "../platform";
import { t } from "../i18n";

export interface Source {
  id: string;
  title: string;
  siteUrl: string;
  feedUrl: string;
  /** "manual" = articles saved by hand (保存网页 / pasted link / bookmarklet); never fetched. */
  kind: "feed" | "wechat-album" | "manual";
  etag?: string | null;
  lastModified?: string | null;
  lastFetched?: number | null;
  lastError?: string | null;
  errorCount: number;
  createdAt: number;
  unread: number;
  total: number;
  /** Reading interests ("基督教", "AI", "法律"…); a source can have several. */
  interests: string[];
}

export interface RawItem {
  url: string;
  title: string;
  author: string;
  publishedAt: number;
  html: string;
  image: string;
}

export interface FetchResult {
  notModified: boolean;
  etag?: string | null;
  lastModified?: string | null;
  finalUrl: string;
  kind: Source["kind"];
  title: string;
  siteUrl: string;
  items: RawItem[];
}

export interface FeedItem {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  author: string;
  publishedAt: number;
  summary: string;
  image: string;
  status: "new" | "read" | "saved" | "dismissed";
}

export type ItemView = "all" | "unread" | "saved" | "dismissed";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(t("err.feedsDesktop"));
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const feedsApi = {
  fetch: (url: string, etag?: string | null, lastModified?: string | null) => invoke<FetchResult>("feed_fetch", { url, etag: etag ?? null, lastModified: lastModified ?? null }),
  sources: () => (isTauri ? invoke<Source[]>("sources_list") : Promise.resolve([] as Source[])),
  saveSource: (source: Source) => invoke<void>("source_save", { source }),
  deleteSource: (id: string) => invoke<void>("source_delete", { id }),
  upsert: (sourceId: string, items: { url: string; title: string; author: string; publishedAt: number; summary: string; image: string }[]) =>
    invoke<number>("items_upsert", { sourceId, items }),
  query: (q: { sourceId?: string; sourceIds?: string[]; view?: ItemView; q?: string; limit?: number; offset?: number }) =>
    isTauri ? invoke<{ items: FeedItem[]; total: number }>("items_query", { query: q }) : Promise.resolve({ items: [], total: 0 }),
  setStatus: (ids: string[], status: FeedItem["status"]) => invoke<void>("items_set_status", { ids, status }),
  markAllRead: (sourceId?: string) => invoke<number>("items_mark_all_read", { sourceId: sourceId ?? null }),
  /** A saved article left the library: drop it from the inbox too. */
  unsave: (id: string) => (isTauri ? invoke<void>("item_unsave", { id }) : Promise.resolve()),
  setSummary: (id: string, summary: string) => invoke<void>("item_set_summary", { id, summary }),
  prune: (before: number) => invoke<number>("items_prune", { before }),
  unread: () => (isTauri ? invoke<number>("items_unread_count") : Promise.resolve(0)),
};

// ---------- change notifications ----------
let version = 0;
const listeners = new Set<() => void>();
export function feedsChanged() {
  version++;
  listeners.forEach((l) => l());
}
export function useFeedsVersion() {
  const [v, setV] = useState(version);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return v;
}

// ---------- hand-picked articles ----------
export const MANUAL_SOURCE_ID = "manual";

/**
 * Record an article saved by hand in the inbox (source "手动添加"), so the subscriptions page is the one
 * place where every article you found lives. If a feed already carries the same URL, that item is marked saved.
 */
export async function recordManualArticle(a: { id: string; url: string; title: string; author?: string; summary?: string }) {
  const sources = await feedsApi.sources();
  if (!sources.some((s) => s.id === MANUAL_SOURCE_ID)) {
    await feedsApi.saveSource({
      id: MANUAL_SOURCE_ID,
      title: t("ib.manual"),
      siteUrl: "",
      feedUrl: "manual:",
      kind: "manual",
      errorCount: 0,
      createdAt: 0,
      unread: 0,
      total: 0,
      interests: [],
    });
  }
  await feedsApi.upsert(MANUAL_SOURCE_ID, [{ url: a.url, title: a.title, author: a.author ?? "", publishedAt: Date.now(), summary: a.summary ?? "", image: "" }]);
  // Inbox item ids and saved-article ids are both the normalized-URL hash, so the book id addresses the item.
  await feedsApi.setStatus([a.id], "saved");
  feedsChanged();
}

// ---------- reading interests ----------
/** Every interest in use, with how many sources carry it (most used first). */
export function interestCounts(sources: Source[]) {
  const m = new Map<string, number>();
  for (const s of sources) for (const t of s.interests ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

/** Stable colour per interest name (hue), so "AI" is always the same colour everywhere. */
export function interestHue(name: string) {
  let h = 7;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

export async function setSourceInterests(source: Source, interests: string[]) {
  await feedsApi.saveSource({ ...source, interests });
  feedsChanged();
}
