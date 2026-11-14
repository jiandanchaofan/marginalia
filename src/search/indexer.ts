import { useEffect, useState } from "react";
import type { BookRecord } from "../core/types";
import { openBook } from "../openBook";
import { bookIndex, INDEX_VERSION } from "./backend";
import { chunkParagraphs } from "./normalize";

/** Formats whose text can be read out (a PDF that is only scanned pictures has none, and is skipped quickly). */
export const searchable = (_b: Pick<BookRecord, "format">) => true;

export interface IndexState {
  running: boolean;
  done: number;
  total: number;
  /** Title of the book being read now. */
  current: string;
  /** Books in the index / books that could be in it. */
  indexed: number;
  eligible: number;
  /** Bytes the index takes. */
  size: number;
  failed: number;
  /** Books in the index that turned out to have no text at all (scans). */
  noText: number;
}

let state: IndexState = { running: false, done: 0, total: 0, current: "", indexed: 0, eligible: 0, size: 0, failed: 0, noText: 0 };
const listeners = new Set<() => void>();
const set = (p: Partial<IndexState>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
const failed = new Set<string>();
let again = false;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read one book's text into the index. */
export async function indexBook(b: BookRecord) {
  const doc = await openBook(b);
  try {
    const sections = (await doc.extractText?.()) ?? [];
    const chunks = sections.flatMap((paras, section) => chunkParagraphs(paras).map((text) => ({ section, text })));
    await bookIndex.replace(b.id, chunks, sections.length);
  } finally {
    doc.destroy();
  }
}

/** Bring the index in line with the shelf: forget removed books, read the ones that are new (one at a time, in the background). */
export async function syncIndex(books: BookRecord[], opts: { force?: boolean } = {}) {
  if (state.running) {
    again = true;
    return;
  }
  const eligible = books.filter(searchable);
  const onShelf = new Set(books.map((b) => b.id));
  set({ running: true, eligible: eligible.length });
  try {
    if (opts.force) {
      await bookIndex.clear();
      failed.clear();
    }
    const have = new Map((await bookIndex.status()).map((s) => [s.bookId, s]));
    for (const id of have.keys()) if (!onShelf.has(id)) await bookIndex.remove(id);
    const todo = eligible.filter((b) => !failed.has(b.id) && (!have.has(b.id) || have.get(b.id)!.version !== INDEX_VERSION));
    set({ total: todo.length, done: 0, indexed: eligible.length - todo.length });
    let n = 0;
    for (const b of todo) {
      set({ current: b.title });
      try {
        await indexBook(b);
      } catch {
        failed.add(b.id);
      }
      n++;
      set({ done: n, indexed: eligible.length - todo.length + n - failed.size });
      await pause(40);
    }
    const after = await bookIndex.status();
    set({ size: await bookIndex.size().catch(() => 0), failed: failed.size, noText: after.filter((s) => s.chars === 0).length });
  } finally {
    set({ running: false, current: "" });
    if (again) {
      again = false;
      void syncIndex(books);
    }
  }
}

export const indexState = () => state;

export function useIndexState(): IndexState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const on = () => setS(state);
    listeners.add(on);
    on();
    return () => void listeners.delete(on);
  }, []);
  return s;
}
