import type { BookRecord } from "../core/types";
import { PALETTE, STYLES, styleName, swatch } from "../core/palette";
import { tagSpans } from "./tags";
import type { NoteHit, NoteQuery } from "./store";

export interface NotesFilter {
  q: string;
  tags: string[];
  tagMode: "and" | "or";
  bookIds?: string[];
  colors: string[];
  hasText?: boolean;
  /** "doc" = whole-book/article notes, "passage" = notes on selected text, "free" = standalone 随手记. */
  kind?: "doc" | "passage" | "free";
  /** Only notes created on this local day (`YYYY-MM-DD`), picked from the heat map. */
  day?: string;
  sort: "time" | "position" | "type";
}

export const EMPTY_FILTER: NotesFilter = { q: "", tags: [], tagMode: "and", colors: [], sort: "time" };

/**
 * Search box syntax (all combinable with free text):
 *   #标签            tag (includes children)
 *   书:标题 / book:  source whose title contains the text
 *   色:琥珀 / color: colour by name or key
 *   样式:波浪线 / style:
 *   有想法 / is:thought   only notes with a thought
 */
export interface ParsedSearch {
  terms: string[];
  tags: string[];
  books: string[];
  colors: string[];
  styles: string[];
  /** true = only notes with text, false = only highlights without text. */
  thought?: boolean;
  kind?: "doc" | "passage" | "free";
}

const OPS: Record<string, keyof Omit<ParsedSearch, "terms" | "tags" | "thought">> = {
  "书": "books",
  book: "books",
  "色": "colors",
  "颜色": "colors",
  color: "colors",
  "样式": "styles",
  style: "styles",
};
const KIND_KEYS = new Set(["类型", "type"]);

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { terms: [], tags: tagSpans(q).map((s) => s.tag), books: [], colors: [], styles: [], thought: undefined };
  let rest = q;
  for (const s of [...tagSpans(q)].reverse()) rest = `${rest.slice(0, s.start)} ${rest.slice(s.end)}`;
  for (const word of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([^:：]+)[:：](.+)$/.exec(word);
    if (m && KIND_KEYS.has(m[1].toLowerCase())) {
      const v = m[2].toLowerCase();
      if (["整体", "整篇", "整本", "全局", "阅读全局笔记", "doc"].includes(v)) out.kind = "doc";
      else if (["批注", "批注笔记"].includes(v)) (out.kind = "passage"), (out.thought = true);
      else if (["原文摘录", "划线"].includes(v)) (out.kind = "passage"), (out.thought = false);
      else if (["摘录", "passage"].includes(v)) out.kind = "passage";
      else if (["随手记", "随手", "free", "memo"].includes(v)) out.kind = "free";
      continue;
    }
    if (word === "整体笔记" || word === "阅读全局笔记") {
      out.kind = "doc";
      continue;
    }
    const field = m && OPS[m[1].toLowerCase()];
    if (field) {
      const v = m![2];
      if (field === "colors") {
        const p = PALETTE.find((c) => c.key === v.toLowerCase() || c.name === v);
        if (p) out.colors.push(p.key);
      } else if (field === "styles") {
        const st = STYLES.find((s) => s.key === v.toLowerCase() || s.name === v);
        out.styles.push(st ? st.key : v === "仅笔记" || v === "无" ? "none" : v);
      } else out.books.push(v.toLowerCase());
    } else if (word === "有想法" || word.toLowerCase() === "is:thought") out.thought = true;
    else if (word === "批注笔记") (out.kind = "passage"), (out.thought = true);
    else if (word === "原文摘录") (out.kind = "passage"), (out.thought = false);
    else out.terms.push(word);
  }
  return out;
}

/** [start of day, start of next day) in local time. */
function dayRange(day?: string): { after?: number; before?: number } {
  const m = day && /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return {};
  const start = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return { after: start, before: new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() };
}

export const dayLabel = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${y === new Date().getFullYear() ? "" : `${y}年`}${m}月${d}日`;
};

export function toQuery(f: NotesFilter, books?: Map<string, BookRecord>): NoteQuery {
  const p = parseSearch(f.q);
  let bookIds = f.bookIds;
  if (p.books.length && books) {
    const hit = [...books.values()].filter((b) => p.books.some((t) => b.title.toLowerCase().includes(t))).map((b) => b.id);
    bookIds = bookIds ? bookIds.filter((id) => hit.includes(id)) : hit;
  }
  return {
    bookIds,
    tags: [...new Set([...f.tags, ...p.tags])],
    tagMode: f.tagMode,
    colors: [...new Set([...f.colors, ...p.colors])],
    styles: p.styles,
    hasText: p.thought ?? f.hasText,
    kind: p.kind ?? f.kind,
    ...dayRange(f.day),
    terms: p.terms,
    sort: f.sort,
  };
}

export const isFiltered = (f: NotesFilter) => !!(f.q.trim() || f.tags.length || f.colors.length || f.hasText !== undefined || f.kind || f.day || f.bookIds);

/** Human-readable summary, e.g. "#AI · 《页边的艺术》 · 有想法 · “上下文”". */
export function describeFilter(f: NotesFilter, books: Map<string, BookRecord>, sourceLabel?: string) {
  const parts: string[] = [];
  if (sourceLabel) parts.push(sourceLabel);
  else if (f.bookIds?.length === 1) parts.push(`《${books.get(f.bookIds[0])?.title ?? "?"}》`);
  parts.push(...f.tags.map((t) => `#${t}`));
  if (f.colors.length) parts.push(f.colors.map((c) => swatch(c).name).join("/"));
  if (f.kind === "passage" && f.hasText !== undefined) parts.push(f.hasText ? "批注笔记" : "原文摘录");
  else {
    if (f.hasText) parts.push("有想法");
    if (f.kind) parts.push(f.kind === "doc" ? "阅读全局笔记" : f.kind === "free" ? "随手记" : "原文笔记");
  }
  if (f.day) parts.push(dayLabel(f.day));
  if (f.q.trim()) parts.push(`“${f.q.trim()}”`);
  return parts.join(" · ") || "全部笔记";
}

/** Markdown export, grouped by source in reading order. Tags stay inline (`#a/b`), which Obsidian reads as nested tags. */
/** Obsidian embeds: one `![[file]]` per picture; the files go to an `attachments` folder beside the .md. */
export const imageEmbeds = (ids?: string[]) => (ids ?? []).map((id) => `![[${id}]]`);
export const imageIdsOf = (hits: { note: { images?: string[] } }[]) => [...new Set(hits.flatMap((h) => h.note.images ?? []))];

export function notesToMarkdown(hits: NoteHit[], books: Map<string, BookRecord>, heading: string) {
  const sorted = [...hits].sort(
    (x, y) =>
      (books.get(x.bookId)?.title ?? "").localeCompare(books.get(y.bookId)?.title ?? "", "zh-CN") ||
      x.note.anchor.section - y.note.anchor.section ||
      x.note.anchor.start - y.note.anchor.start,
  );
  const lines = [`# ${heading}`, "", `> 导出自「墨边」· ${new Date().toLocaleString()} · 共 ${hits.length} 条笔记`, ""];
  const free = hits.filter((h) => h.note.kind === "free").sort((x, y) => y.note.createdAt - x.note.createdAt);
  if (free.length) {
    lines.push("## 随手记", "");
    for (const { note } of free) lines.push(note.note.trim(), ...(note.images?.length ? ["", ...imageEmbeds(note.images)] : []), "", `<sub>${new Date(note.createdAt).toLocaleString()}</sub>`, "", "---", "");
  }
  let current = "";
  let sectionOpen = false; // inside the 整体笔记 block of the current book
  for (const { bookId, note } of sorted) {
    if (note.kind === "free") continue;
    if (bookId !== current) {
      current = bookId;
      sectionOpen = false;
      const b = books.get(bookId);
      lines.push(`## 《${b?.title ?? "已移除的书"}》${b?.author ? ` · ${b.author}` : ""}`, "");
    }
    if (note.kind === "doc") {
      if (!sectionOpen) lines.push("### 整体笔记", "");
      sectionOpen = true;
      lines.push(note.note.trim(), ...(note.images?.length ? ["", ...imageEmbeds(note.images)] : []), "", `<sub>${new Date(note.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
      continue;
    }
    if (sectionOpen) lines.push("### 摘录与笔记", "");
    sectionOpen = false;
    lines.push(`> ${note.anchor.exact.trim().replace(/\n+/g, "\n> ")}`, "");
    if (note.note.trim()) lines.push(note.note.trim(), "");
    if (note.images?.length) lines.push(...imageEmbeds(note.images), "");
    lines.push(`<sub>${swatch(note.color).name} · ${styleName(note.style)} · ${new Date(note.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
  }
  return lines.join("\n");
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
