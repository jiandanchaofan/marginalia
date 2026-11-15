/**
 * Notes store. Desktop/mobile: SQLite via Rust commands. Plain browser (`npm run dev`):
 * localStorage + the same filtering logic in JS (`filterHits`), so the UI behaves identically.
 */
import { useEffect, useState } from "react";
import type { Annotation, GraphPos, NoteLink } from "../core/types";
import { isTauri } from "../platform";
import { hasThought, isUnder, normalizeTag, parseTags, tagSpans } from "./tags";
import { syncTasksFor } from "../tasks/sync";
import { tasksStore } from "../tasks/store";
import { t } from "../i18n";
import { aliasPairs, familyOf } from "./aliases";

export interface NoteHit {
  bookId: string;
  note: Annotation;
}

export interface NoteQuery {
  bookIds?: string[];
  tags?: string[];
  tagMode?: "and" | "or";
  colors?: string[];
  styles?: string[];
  hasText?: boolean;
  /** "doc" = whole-book/article notes only, "passage" = text-anchored notes only, "free" = standalone 随手记. */
  kind?: "doc" | "passage" | "free";
  terms?: string[];
  sort?: "time" | "position" | "type" | "shuffle";
  /** Seed for "shuffle" — same seed, same order (daily review uses the day number). */
  seed?: number;
  /** Only notes created before this time (ms). */
  before?: number;
  /** Only notes created at or after this time (ms). */
  after?: number;
  /** -1 = no limit. */
  limit?: number;
  offset?: number;
}

export interface NoteStats {
  /** Local day `YYYY-MM-DD` → notes created that day. */
  days: Record<string, number>;
  total: number;
  tags: number;
}

/** Local calendar day key, the same format the backend groups by. */
export const dayKey = (t: number | Date) => {
  const d = typeof t === "number" ? new Date(t) : t;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface TagInfo {
  tag: string;
  count: number;
  own: number;
  pinned: boolean;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Keep `tags` consistent with the text before anything is persisted. */
export const withTags = (a: Annotation): Annotation => ({ ...a, tags: parseTags(a.note) });

// ---------- shared JS filtering (browser store + live in-book list) ----------
export function filterHits(hits: NoteHit[], q: NoteQuery): NoteHit[] {
  const terms = (q.terms ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const out = hits.filter(({ bookId, note: a }) => {
    if (q.bookIds && !q.bookIds.includes(bookId)) return false;
    if (q.colors?.length && !q.colors.includes(a.color)) return false;
    if (q.styles?.length && !q.styles.includes(a.style)) return false;
    if (q.hasText !== undefined && hasThought(a.note) !== q.hasText) return false;
    if (q.kind && (a.kind ?? "passage") !== q.kind) return false;
    if (q.before !== undefined && a.createdAt >= q.before) return false;
    if (q.after !== undefined && a.createdAt < q.after) return false;
    if (q.tags?.length) {
      const tags = parseTags(a.note);
      const match = (t: string) => tags.some((x) => isUnder(x, t));
      if (q.tagMode === "or" ? !q.tags.some(match) : !q.tags.every(match)) return false;
    }
    if (terms.length) {
      const hay = `${a.anchor.exact}\n${a.note}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  if (q.sort === "shuffle") {
    const key = (id: string) => {
      let h = 2166136261 ^ (q.seed ?? 0);
      for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
      return h >>> 0;
    };
    return out.sort((x, y) => key(x.note.id) - key(y.note.id));
  }
  const rank = (a: Annotation) => (a.kind === "free" ? 0 : a.kind === "doc" ? 2 : hasThought(a.note) ? 1 : 3);
  out.sort((x, y) =>
    q.sort === "type"
      ? rank(x.note) - rank(y.note) || y.note.createdAt - x.note.createdAt
      : q.sort === "position"
      ? x.bookId.localeCompare(y.bookId) || x.note.anchor.section - y.note.anchor.section || x.note.anchor.start - y.note.anchor.start
      : y.note.createdAt - x.note.createdAt,
  );
  return out;
}

export function tagStats(hits: NoteHit[], aliases: [string, string][] = []): TagInfo[] {
  const all = new Map<string, Set<string>>();
  const own = new Map<string, number>();
  const shown = new Map(aliases);
  for (const { note } of hits) {
    for (const raw of parseTags(note.note)) {
      const tag = shown.get(raw) ?? raw;
      own.set(tag, (own.get(tag) ?? 0) + 1);
      const parts = tag.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!all.has(p)) all.set(p, new Set());
        all.get(p)!.add(note.id);
      }
    }
  }
  return [...all].map(([tag, ids]) => ({ tag, count: ids.size, own: own.get(tag) ?? 0, pinned: browserPins().includes(tag) }));
}

// ---------- browser fallback persistence ----------
const LS_PREFIX = "reader:notes:";
const ls = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* unavailable */
    }
  },
  keys(): string[] {
    try {
      return Object.keys(localStorage);
    } catch {
      return [];
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* unavailable */
    }
  },
};
const browserBook = (bookId: string): Annotation[] => {
  try {
    return JSON.parse(ls.get(LS_PREFIX + bookId) ?? "[]");
  } catch {
    return [];
  }
};
const browserAll = (): NoteHit[] =>
  ls
    .keys()
    .filter((k) => k.startsWith(LS_PREFIX))
    .flatMap((k) => browserBook(k.slice(LS_PREFIX.length)).map((note) => ({ bookId: k.slice(LS_PREFIX.length), note })));
const LS_LINKS = "reader:note-links";
const LS_POS = "reader:graph-pos";
/** Links whose notes were deleted are dropped on read (the desktop database does this with a cascade). */
const browserLinks = (): NoteLink[] => {
  try {
    const list: NoteLink[] = JSON.parse(ls.get(LS_LINKS) ?? "[]");
    if (!list.length) return list;
    const ids = new Set(browserAll().map((h) => h.note.id));
    return list.filter((l) => ids.has(l.a) && ids.has(l.b));
  } catch {
    return [];
  }
};
const browserPos = (): GraphPos[] => {
  try {
    return JSON.parse(ls.get(LS_POS) ?? "[]");
  } catch {
    return [];
  }
};
const browserPins = (): string[] => {
  try {
    return JSON.parse(ls.get("reader:tag-pins") ?? "[]");
  } catch {
    return [];
  }
};
function browserRetag(from: string, to: string | null) {
  let n = 0;
  const bookIds = ls.keys().filter((k) => k.startsWith(LS_PREFIX)).map((k) => k.slice(LS_PREFIX.length));
  for (const bookId of bookIds) {
    const list = browserBook(bookId).map((a) => {
      if (!parseTags(a.note).some((t) => isUnder(t, from))) return a;
      n++;
      const note = rewriteTags(a.note, from, to);
      return withTags({ ...a, note });
    });
    ls.set(LS_PREFIX + bookId, JSON.stringify(list));
  }
  return n;
}

/** JS twin of the Rust `rewrite_tags`. */
export function rewriteTags(text: string, from: string, to: string | null): string {
  let out = "";
  let last = 0;
  for (const s of tagSpans(text)) {
    if (!isUnder(s.tag, from)) continue;
    out += text.slice(last, s.start);
    if (to !== null) out += `#${to}${s.tag.slice(from.length)}`;
    last = s.end;
  }
  out += text.slice(last);
  return to === null ? out.split(" ").filter(Boolean).join(" ").trim() : out;
}

// ---------- change notifications ----------
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
export function notesChanged() {
  version++;
  listeners.forEach((l) => l());
}
/** Re-render when notes/tags change anywhere (returns a counter usable as an effect dependency). */
export function useNotesVersion() {
  const [v, setV] = useState(version);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return v;
}

/** Global tag list for autocomplete, refreshed whenever notes change. */
export function useGlobalTags() {
  const v = useNotesVersion();
  const [tags, setTags] = useState<TagInfo[]>([]);
  useEffect(() => {
    let alive = true;
    notesStore.tags().then((t) => alive && setTags(t));
    return () => {
      alive = false;
    };
  }, [v]);
  return tags;
}

// ---------- public API ----------
/** Which notes each book had when we last saw it, so a save that drops notes can tell the task library (their tasks go with them). */
const seenIds = new Map<string, Set<string>>();
/** The notes themselves as last seen, so a save that drops some can hand them to the recycle bin. */
const seenNotes = new Map<string, Map<string, Annotation>>();

/** The recycle bin hooks in here: it gets the notes about to be deleted and returns the ids of the entries it made. */
type RemovalHook = (hits: NoteHit[]) => Promise<string[]>;
let removalHook: RemovalHook | null = null;
export const setRemovalHook = (h: RemovalHook) => void (removalHook = h);
/** Entries made by the most recent deletion (for "undo"). */
export let lastTrashed: string[] = [];
const toTrash = async (hits: NoteHit[]) => {
  lastTrashed = hits.length && removalHook ? await removalHook(hits).catch(() => []) : [];
  return lastTrashed;
};

export const notesStore = {
  async forBook(bookId: string): Promise<Annotation[]> {
    const list = isTauri ? await invoke<Annotation[]>("notes_for_book", { bookId }) : browserBook(bookId);
    seenIds.set(bookId, new Set(list.map((n) => n.id)));
    seenNotes.set(bookId, new Map(list.map((n) => [n.id, n])));
    return list;
  },

  async putBook(bookId: string, notes: Annotation[]) {
    const list = notes.map(withTags);
    const before = seenIds.get(bookId) ?? new Set(isTauri ? [] : browserBook(bookId).map((n) => n.id));
    const keep = new Set(list.map((n) => n.id));
    const removed = [...before].filter((id) => !keep.has(id));
    const known = seenNotes.get(bookId);
    await toTrash(removed.map((id) => known?.get(id)).filter((a): a is Annotation => !!a).map((note) => ({ bookId, note })));
    if (isTauri) await invoke("notes_put_book", { bookId, notes: list });
    else if (list.length) ls.set(LS_PREFIX + bookId, JSON.stringify(list));
    else ls.del(LS_PREFIX + bookId);
    seenIds.set(bookId, keep);
    seenNotes.set(bookId, new Map(list.map((n) => [n.id, n])));
    if (removed.length) tasksStore.dropByNotes(removed);
    void syncTasksFor(list);
    notesChanged();
  },

  /** Insert a new note (standalone 随手记 live under `FREE_BOOK`). */
  async add(bookId: string, note: Annotation, opts?: { noSync?: boolean }) {
    const n = withTags(note);
    if (isTauri) await invoke("note_update", { bookId, note: n });
    else ls.set(LS_PREFIX + bookId, JSON.stringify([...browserBook(bookId), n]));
    seenIds.get(bookId)?.add(n.id);
    seenNotes.get(bookId)?.set(n.id, n);
    if (!opts?.noSync) void syncTasksFor([n]);
    notesChanged();
  },

  async update(bookId: string, note: Annotation) {
    const n = withTags(note);
    if (isTauri) await invoke("note_update", { bookId, note: n });
    else ls.set(LS_PREFIX + bookId, JSON.stringify(browserBook(bookId).map((a) => (a.id === n.id ? n : a))));
    void syncTasksFor([n]);
    notesChanged();
  },

  /** Update several notes, notifying listeners once. */
  async updateMany(hits: NoteHit[]) {
    for (const h of hits) {
      const n = withTags(h.note);
      if (isTauri) await invoke("note_update", { bookId: h.bookId, note: n });
      else ls.set(LS_PREFIX + h.bookId, JSON.stringify(browserBook(h.bookId).map((a) => (a.id === n.id ? n : a))));
    }
    void syncTasksFor(hits.map((h) => withTags(h.note)));
    notesChanged();
  },

  /** Delete notes (into the recycle bin first). Returns the bin entries, for undo. */
  async removeMany(hits: NoteHit[]): Promise<string[]> {
    const entries = await toTrash(hits);
    for (const h of hits) {
      if (isTauri) await invoke("note_delete", { id: h.note.id });
      else ls.set(LS_PREFIX + h.bookId, JSON.stringify(browserBook(h.bookId).filter((a) => a.id !== h.note.id)));
      seenIds.get(h.bookId)?.delete(h.note.id);
      seenNotes.get(h.bookId)?.delete(h.note.id);
    }
    tasksStore.dropByNotes(hits.map((h) => h.note.id));
    notesChanged();
    return entries;
  },

  async remove(bookId: string, id: string): Promise<string[]> {
    const [hit] = await this.byIds([id]);
    const entries = await toTrash(hit ? [hit] : []);
    if (isTauri) await invoke("note_delete", { id });
    else ls.set(LS_PREFIX + bookId, JSON.stringify(browserBook(bookId).filter((a) => a.id !== id)));
    seenIds.get(bookId)?.delete(id);
    seenNotes.get(bookId)?.delete(id);
    tasksStore.dropByNotes([id]);
    notesChanged();
    return entries;
  },

  async query(q0: NoteQuery): Promise<{ items: NoteHit[]; total: number }> {
    // choosing one tag of a family (a to-do review, a weekly review) finds every spelling of it
    const fam = q0.tags?.length === 1 ? familyOf(q0.tags[0]) : null;
    const q: NoteQuery = fam ? { ...q0, tags: fam, tagMode: "or" } : q0;
    if (isTauri) return invoke("notes_query", { filter: q });
    const all = filterHits(browserAll(), q);
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 100;
    return { items: limit < 0 ? all.slice(offset) : all.slice(offset, offset + limit), total: all.length };
  },

  async tags(bookId?: string): Promise<TagInfo[]> {
    const aliases = aliasPairs();
    if (isTauri) return invoke("tags_list", { bookId: bookId ?? null, aliases });
    return tagStats(bookId ? browserBook(bookId).map((note) => ({ bookId, note })) : browserAll(), aliases);
  },

  async renameTag(from: string, to: string): Promise<number> {
    const n = isTauri ? await invoke<number>("tag_rename", { from, to }) : browserRetag(from, to);
    await (await import("../tasks/retag")).retagTasks(from, normalizeTag(to) || null).catch((e) => console.warn("retag tasks failed", e));
    notesChanged();
    return n;
  },

  async deleteTag(tag: string): Promise<number> {
    const n = isTauri ? await invoke<number>("tag_delete", { tag }) : browserRetag(tag, null);
    await (await import("../tasks/retag")).retagTasks(tag, null).catch((e) => console.warn("retag tasks failed", e));
    notesChanged();
    return n;
  },

  async pinTag(tag: string, pinned: boolean) {
    if (isTauri) await invoke("tag_pin", { tag, pinned });
    else ls.set("reader:tag-pins", JSON.stringify(pinned ? [...new Set([...browserPins(), tag])] : browserPins().filter((t) => t !== tag)));
    notesChanged();
  },

  /** Books that have whole-document notes, with how many. */
  async docCounts(): Promise<Record<string, number>> {
    if (isTauri) return invoke("note_doc_counts");
    const out: Record<string, number> = {};
    browserAll().forEach((h) => h.note.kind === "doc" && (out[h.bookId] = (out[h.bookId] ?? 0) + 1));
    return out;
  },

  async counts(): Promise<Record<string, number>> {
    if (isTauri) return invoke("note_counts");
    const out: Record<string, number> = {};
    browserAll().forEach((h) => (out[h.bookId] = (out[h.bookId] ?? 0) + 1));
    return out;
  },

  /** Per-day note counts (every kind of note) for the heat map. */
  async stats(): Promise<NoteStats> {
    if (isTauri) return invoke("notes_stats", { tzOffsetMin: -new Date().getTimezoneOffset() });
    const all = browserAll();
    const days: Record<string, number> = {};
    all.forEach((h) => {
      const k = dayKey(h.note.createdAt);
      days[k] = (days[k] ?? 0) + 1;
    });
    return { days, total: all.length, tags: tagStats(all).length ? new Set(all.flatMap((h) => parseTags(h.note.note))).size : 0 };
  },

  // ---- links between notes (many-to-many) ----
  async links(): Promise<NoteLink[]> {
    return isTauri ? invoke<NoteLink[]>("links_all") : browserLinks();
  },

  /** Create or update links. Each link is stored with `a` < `b`. */
  async putLinks(links: NoteLink[]) {
    const norm = links.map((l) => (l.a <= l.b ? { ...l, label: l.label.trim() } : { ...l, a: l.b, b: l.a, sideA: l.sideB, sideB: l.sideA, label: l.label.trim() }));
    if (norm.some((l) => l.a === l.b)) throw new Error(t("err.selfLink"));
    if (isTauri) await invoke("links_put", { links: norm });
    else {
      const map = new Map(browserLinks().map((l) => [l.id, l]));
      norm.forEach((l) => map.set(l.id, l));
      ls.set(LS_LINKS, JSON.stringify([...map.values()]));
    }
    notesChanged();
  },

  async removeLink(id: string) {
    if (isTauri) await invoke("link_delete", { id });
    else ls.set(LS_LINKS, JSON.stringify(browserLinks().filter((l) => l.id !== id)));
    notesChanged();
  },

  /** Notes at a canonical position: exactly `ref`, a range that starts there, or anything inside it ("JHN" finds all of John). */
  async byRef(ref: string): Promise<NoteHit[]> {
    const r = ref.trim();
    if (!r) return [];
    if (isTauri) return invoke<NoteHit[]>("notes_by_ref", { canonicalRef: r });
    return browserAll().filter(({ note }) => !!note.canonicalRef && (note.canonicalRef === r || note.canonicalRef.startsWith(r + ".") || note.canonicalRef.startsWith(r + "-")));
  },

  /** Notes by id, in the order asked for (unknown ids skipped). */
  async byIds(ids: string[]): Promise<NoteHit[]> {
    if (!ids.length) return [];
    if (isTauri) return invoke<NoteHit[]>("notes_by_ids", { ids });
    const by = new Map(browserAll().map((h) => [h.note.id, h]));
    return ids.map((id) => by.get(id)).filter((h): h is NoteHit => !!h);
  },

  async graphPos(): Promise<GraphPos[]> {
    return isTauri ? invoke<GraphPos[]>("graph_pos_all") : browserPos();
  },

  async putGraphPos(positions: GraphPos[]) {
    if (isTauri) await invoke("graph_pos_put", { positions });
    else {
      const map = new Map(browserPos().map((p) => [p.noteId, p]));
      positions.forEach((p) => map.set(p.noteId, p));
      ls.set(LS_POS, JSON.stringify([...map.values()]));
    }
  },

  async removeBook(bookId: string) {
    const ids = isTauri ? [] : browserBook(bookId).map((n) => n.id);
    if (!isTauri) ls.del(LS_PREFIX + bookId);
    seenIds.delete(bookId);
    seenNotes.delete(bookId);
    tasksStore.dropByNotes(ids); // on the desktop the database already dropped them with the notes: this just re-reads
    notesChanged();
  },
};

/** Run `fn` whenever notes change in this window (used to tell the other windows). */
export function subscribeNotes(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
