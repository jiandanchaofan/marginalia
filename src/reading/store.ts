/**
 * Reading time: seconds read per day and book, plus the progress at the start and end of that day.
 * Desktop: SQLite via Rust commands. Plain browser: localStorage. Cached in memory; everything goes through `add`.
 */
import { useEffect, useState } from "react";
import { isTauri } from "../platform";

export interface ReadingDay {
  day: string; // YYYY-MM-DD (local)
  bookId: string;
  secs: number;
  p0: number; // progress (0-1) the first time the book was read that day
  p1: number; // and the latest
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const KEY = "reader:reading-days";
const readBrowser = (): ReadingDay[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const saveBrowser = (rows: ReadingDay[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    /* storage unavailable or full */
  }
};

let cache: ReadingDay[] | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export const readingStore = {
  async all(): Promise<ReadingDay[]> {
    if (!cache) cache = isTauri ? await invoke<ReadingDay[]>("reading_all") : readBrowser();
    return cache;
  },
  /** Add `secs` of reading of `bookId` on `day`, when the book stood at `progress` (0-1). */
  async add(day: string, bookId: string, secs: number, progress: number) {
    if (!(secs > 0)) return;
    const rows = await this.all();
    const p = Math.min(1, Math.max(0, progress));
    const hit = rows.find((r) => r.day === day && r.bookId === bookId);
    if (hit) {
      hit.secs += secs;
      hit.p1 = p;
    } else {
      rows.push({ day, bookId, secs, p0: p, p1: p });
    }
    if (isTauri) await invoke("reading_add", { day, bookId, secs, progress: p });
    else saveBrowser(rows);
    changed();
  },
  async clear() {
    if (isTauri) await invoke("reading_clear");
    else saveBrowser([]);
    cache = [];
    changed();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** All reading days, re-read whenever new reading is recorded. */
export function useReading(): ReadingDay[] {
  const [tick, setTick] = useState(version);
  const [rows, setRows] = useState<ReadingDay[]>([]);
  useEffect(() => readingStore.subscribe(() => setTick(version)), []);
  useEffect(() => {
    let alive = true;
    readingStore.all().then((r) => alive && setRows([...r]));
    return () => {
      alive = false;
    };
  }, [tick]);
  return rows;
}
