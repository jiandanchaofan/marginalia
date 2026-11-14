/**
 * Note review schedule and answers. Desktop: SQLite via Rust commands. Plain browser: localStorage.
 * Cached in memory; everything that changes the schedule goes through this store.
 */
import { useEffect, useState } from "react";
import { isTauri } from "../platform";
import type { LogRow, Rating, ReviewItem } from "./schedule";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface ReviewData {
  items: ReviewItem[];
  log: LogRow[];
}

const KEY = "reader:review";
const readBrowser = (): ReviewData => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && Array.isArray(v.items) && Array.isArray(v.log) ? v : { items: [], log: [] };
  } catch {
    return { items: [], log: [] };
  }
};
const saveBrowser = (d: ReviewData) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable or full */
  }
};

let cache: ReviewData | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export const reviewStore = {
  async all(): Promise<ReviewData> {
    if (!cache) cache = isTauri ? await invoke<ReviewData>("review_all") : readBrowser();
    return cache;
  },
  /** Insert or replace schedules. */
  async put(items: ReviewItem[]) {
    if (!items.length) return;
    const d = await this.all();
    const byId = new Map(d.items.map((i) => [i.noteId, i]));
    for (const it of items) byId.set(it.noteId, byId.has(it.noteId) ? { ...it, added: byId.get(it.noteId)!.added } : it);
    d.items = [...byId.values()];
    if (isTauri) await invoke("review_put", { items });
    else saveBrowser(d);
    changed();
  },
  /** Remember what was answered for a note today (the last answer of the day wins). */
  async logAnswer(day: string, noteId: string, rating: Rating) {
    const d = await this.all();
    d.log = [...d.log.filter((l) => !(l.day === day && l.noteId === noteId)), { day, noteId, rating }];
    if (isTauri) await invoke("review_log_put", { day, noteId, rating });
    else saveBrowser(d);
    changed();
  },
  async reset() {
    if (isTauri) await invoke("review_reset");
    cache = { items: [], log: [] };
    if (!isTauri) saveBrowser(cache);
    changed();
  },
  /** Forget the cache (the database changed behind our back, e.g. notes were deleted). */
  refresh() {
    cache = null;
    changed();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** The review data, re-read whenever it changes. */
export function useReviewData(): ReviewData {
  const [tick, setTick] = useState(version);
  const [data, setData] = useState<ReviewData>({ items: [], log: [] });
  useEffect(() => reviewStore.subscribe(() => setTick(version)), []);
  useEffect(() => {
    let alive = true;
    reviewStore.all().then((d) => alive && setData({ items: [...d.items], log: [...d.log] }));
    return () => {
      alive = false;
    };
  }, [tick]);
  return data;
}
