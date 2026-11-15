/**
 * Where the reader had got to in documents that modules provide (they are not on the shelf, so the library does not
 * keep their position). Stored on this device only; a failing store just means the position is not remembered.
 */
import type { BookRecord } from "../core/types";

const KEY = "reader:virtual:";
const RECENT = "reader:virtual-recent";

export type VirtualState = Pick<BookRecord, "location" | "progress" | "lastOpenedAt"> & { title?: string };
export interface RecentDoc {
  docId: string;
  title: string;
  progress: number;
  at: number;
}

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered */
  }
};

export const loadVirtualState = (docId: string): Partial<VirtualState> => read(KEY + docId, {});

/** Remember a change to a virtual document's record (position, progress, last opened). */
export function saveVirtualState(docId: string, title: string, patch: Partial<BookRecord>) {
  const keep: Partial<VirtualState> = {};
  if ("location" in patch) keep.location = patch.location;
  if ("progress" in patch) keep.progress = patch.progress;
  if ("lastOpenedAt" in patch) keep.lastOpenedAt = patch.lastOpenedAt;
  if (!Object.keys(keep).length) return;
  const state = { ...loadVirtualState(docId), ...keep, title };
  write(KEY + docId, state);
  const list = read<RecentDoc[]>(RECENT, []).filter((r) => r.docId !== docId);
  list.unshift({ docId, title, progress: state.progress ?? 0, at: Date.now() });
  write(RECENT, list.slice(0, 20));
}

/** The documents opened most recently whose id starts with `prefix`, newest first. */
export const recentDocs = (prefix: string): RecentDoc[] => read<RecentDoc[]>(RECENT, []).filter((r) => r.docId.startsWith(prefix));
