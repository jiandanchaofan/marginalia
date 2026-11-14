/**
 * The book-text index. Desktop: its own SQLite file via Rust commands. Plain browser (`npm run dev`): kept in memory,
 * rebuilt each session (the books themselves only live in memory there too).
 */
import { isTauri } from "../platform";
import { normText } from "./normalize";

export const INDEX_VERSION = 1;

export interface Chunk {
  section: number;
  text: string;
}
export interface IndexStatus {
  bookId: string;
  chars: number;
  sections: number;
  indexedAt: number;
  version: number;
}
export interface TextHit {
  bookId: string;
  section: number;
  snippet: string;
  /** How many places in the book matched. */
  count: number;
}
export interface Found {
  hits: TextHit[];
  books: number;
  truncated: boolean;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---- in-memory stand-in for the browser
const mem = new Map<string, { chunks: Chunk[]; status: IndexStatus }>();
function memSnippet(text: string, term: string) {
  const at = Math.max(0, text.toLowerCase().indexOf(term.toLowerCase()));
  const from = Math.max(0, at - 28);
  const to = Math.min(text.length, at + term.length + 70);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

export const bookIndex = {
  async status(): Promise<IndexStatus[]> {
    return isTauri ? invoke<IndexStatus[]>("bidx_status") : [...mem.values()].map((m) => m.status);
  },

  async replace(bookId: string, chunks: Chunk[], sections: number) {
    if (isTauri) return invoke<void>("bidx_replace", { bookId, chunks, sections, version: INDEX_VERSION });
    mem.set(bookId, { chunks, status: { bookId, chars: chunks.reduce((n, c) => n + c.text.length, 0), sections, indexedAt: Date.now(), version: INDEX_VERSION } });
  },

  async remove(bookId: string) {
    if (isTauri) return invoke<void>("bidx_remove", { bookId });
    mem.delete(bookId);
  },

  async clear() {
    if (isTauri) return invoke<void>("bidx_clear");
    mem.clear();
  },

  async size(): Promise<number> {
    if (isTauri) return invoke<number>("bidx_size");
    return [...mem.values()].reduce((n, m) => n + m.status.chars * 2, 0);
  },

  async search(query: string, perBook = 3, maxBooks = 20, only?: string[]): Promise<Found> {
    const term = normText(query);
    if ([...term].length < 2) return { hits: [], books: 0, truncated: false };
    if (isTauri) return invoke<Found>("bidx_search", { query: term, perBook, maxBooks, only: only ?? null });
    const lower = term.toLowerCase();
    const hits: TextHit[] = [];
    let books = 0;
    for (const [bookId, m] of mem) {
      if (only && !only.includes(bookId)) continue;
      const found = m.chunks.filter((c) => c.text.toLowerCase().includes(lower));
      if (!found.length) continue;
      books++;
      if (books <= maxBooks) found.slice(0, perBook).forEach((c) => hits.push({ bookId, section: c.section, snippet: memSnippet(c.text, term), count: found.length }));
    }
    return { hits, books, truncated: false };
  },
};
