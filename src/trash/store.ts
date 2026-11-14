/**
 * The recycle bin. Deleted notes and to-dos stay here for 30 days. Desktop: SQLite via Rust commands; plain browser:
 * localStorage. Each entry keeps a JSON snapshot of the item and what hung on it, so restoring writes everything back.
 */
import { useEffect, useState } from "react";
import { isTauri } from "../platform";

export const KEEP_DAYS = 30;
export const DAY_MS = 86_400_000;

export interface TrashEntry<P = unknown> {
  id: string;
  kind: "note" | "task";
  deletedAt: number;
  /** What the list shows. */
  title: string;
  payload: P;
}

interface Row {
  id: string;
  kind: "note" | "task";
  deletedAt: number;
  title: string;
  payload: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const LS_KEY = "reader:trash";
const readBrowser = (): Row[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const writeBrowser = (rows: Row[]) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rows));
  } catch {
    /* storage unavailable */
  }
};
const parse = (r: Row): TrashEntry => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    /* a broken snapshot can still be thrown away */
  }
  return { id: r.id, kind: r.kind, deletedAt: r.deletedAt, title: r.title, payload };
};

let cache: TrashEntry[] | null = null;
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export const trashStore = {
  async all(): Promise<TrashEntry[]> {
    if (!cache) {
      const rows = isTauri ? await invoke<Row[]>("trash_all") : readBrowser();
      cache = rows.map(parse).sort((a, b) => b.deletedAt - a.deletedAt);
    }
    return cache;
  },

  async put(entries: TrashEntry[]) {
    if (!entries.length) return;
    const rows: Row[] = entries.map((e) => ({ id: e.id, kind: e.kind, deletedAt: e.deletedAt, title: e.title, payload: JSON.stringify(e.payload) }));
    if (isTauri) await invoke("trash_put", { rows });
    else {
      const map = new Map(readBrowser().map((r) => [r.id, r]));
      rows.forEach((r) => map.set(r.id, r));
      writeBrowser([...map.values()]);
    }
    const map = new Map((await this.all()).map((e) => [e.id, e]));
    entries.forEach((e) => map.set(e.id, e));
    cache = [...map.values()].sort((a, b) => b.deletedAt - a.deletedAt);
    changed();
  },

  async remove(ids: string[]) {
    if (!ids.length) return;
    if (isTauri) await invoke("trash_delete", { ids });
    else writeBrowser(readBrowser().filter((r) => !ids.includes(r.id)));
    const gone = new Set(ids);
    cache = (await this.all()).filter((e) => !gone.has(e.id));
    changed();
  },

  /** Throw away everything older than 30 days. */
  async purgeOld(now = Date.now()): Promise<number> {
    const before = now - KEEP_DAYS * DAY_MS;
    let n = 0;
    if (isTauri) n = await invoke<number>("trash_purge", { before });
    else {
      const rows = readBrowser();
      const keep = rows.filter((r) => r.deletedAt >= before);
      n = rows.length - keep.length;
      if (n) writeBrowser(keep);
    }
    if (n) {
      cache = null;
      changed();
    }
    return n;
  },

  /** Forget the cache (another window changed the bin). */
  refresh() {
    cache = null;
    changed();
  },

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** Whole days left before an entry goes for good (at least 0). */
export const daysLeft = (e: TrashEntry, now = Date.now()) => Math.max(0, Math.ceil((e.deletedAt + KEEP_DAYS * DAY_MS - now) / DAY_MS));

/** The bin's contents, re-read whenever it changes. */
export function useTrash(): TrashEntry[] {
  const [tick, setTick] = useState(version);
  const [list, setList] = useState<TrashEntry[]>([]);
  useEffect(() => trashStore.subscribe(() => setTick(version)), []);
  useEffect(() => {
    let alive = true;
    trashStore.all().then((l) => alive && setList([...l]));
    return () => {
      alive = false;
    };
  }, [tick]);
  return list;
}
