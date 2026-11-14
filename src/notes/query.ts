import type { BookRecord } from "../core/types";
import { PALETTE, STYLES, styleName, swatch } from "../core/palette";
import { tagSpans } from "./tags";
import type { NoteHit, NoteQuery } from "./store";
import { anyLang, collate, fmtDate, fmtDateTime, t } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

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
  "書": "books",
  book: "books",
  "色": "colors",
  "颜色": "colors",
  "顏色": "colors",
  color: "colors",
  "样式": "styles",
  "樣式": "styles",
  style: "styles",
};
const KIND_KEYS = new Set(["类型", "類型", "type"]);

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { terms: [], tags: tagSpans(q).map((s) => s.tag), books: [], colors: [], styles: [], thought: undefined };
  let rest = q;
  for (const s of [...tagSpans(q)].reverse()) rest = `${rest.slice(0, s.start)} ${rest.slice(s.end)}`;
  for (const word of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([^:：]+)[:：](.+)$/.exec(word);
    if (m && KIND_KEYS.has(m[1].toLowerCase())) {
      const v = m[2].toLowerCase();
      if (["整体", "整體", "整篇", "整本", "全局", "阅读全局笔记", "閱讀整體筆記", "doc", "whole"].includes(v)) out.kind = "doc";
      else if (["批注", "批注笔记", "批註", "批註筆記", "annotation", "annotations"].includes(v)) (out.kind = "passage"), (out.thought = true);
      else if (["原文摘录", "原文摘錄", "划线", "劃線", "excerpt", "excerpts"].includes(v)) (out.kind = "passage"), (out.thought = false);
      else if (["摘录", "摘錄", "passage"].includes(v)) out.kind = "passage";
      else if (["随手记", "隨手記", "随手", "隨手", "free", "memo", "quick"].includes(v)) out.kind = "free";
      continue;
    }
    if (["整体笔记", "整體筆記", "阅读全局笔记", "閱讀整體筆記"].includes(word)) {
      out.kind = "doc";
      continue;
    }
    const field = m && OPS[m[1].toLowerCase()];
    if (field) {
      const v = m![2];
      if (field === "colors") {
        const p = PALETTE.find((c) => c.key === v.toLowerCase() || anyLang(`color.${c.key}` as Key, v));
        if (p) out.colors.push(p.key);
      } else if (field === "styles") {
        const st = STYLES.find((s) => s.key === v.toLowerCase() || anyLang(`style.${s.key}` as Key, v));
        out.styles.push(st ? st.key : anyLang("style.none", v) || v === "无" || v === "無" ? "none" : v);
      } else out.books.push(v.toLowerCase());
    } else if (word === "有想法" || word.toLowerCase() === "is:thought") out.thought = true;
    else if (word === "批注笔记" || word === "批註筆記") (out.kind = "passage"), (out.thought = true);
    else if (word === "原文摘录" || word === "原文摘錄") (out.kind = "passage"), (out.thought = false);
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
  return fmtDate(new Date(y, m - 1, d), { year: y === new Date().getFullYear() ? undefined : "numeric", month: "long", day: "numeric" });
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
  else if (f.bookIds?.length === 1) parts.push(t("kind.bookQuote", { title: books.get(f.bookIds[0])?.title ?? "?" }));
  parts.push(...f.tags.map((t) => `#${t}`));
  if (f.colors.length) parts.push(f.colors.map((c) => swatch(c).name).join("/"));
  if (f.kind === "passage" && f.hasText !== undefined) parts.push(f.hasText ? t("kind.passageNote") : t("kind.excerpt"));
  else {
    if (f.hasText) parts.push(t("kind.hasThought"));
    if (f.kind) parts.push(f.kind === "doc" ? t("kind.doc") : f.kind === "free" ? t("kind.free") : t("kind.passage"));
  }
  if (f.day) parts.push(dayLabel(f.day));
  if (f.q.trim()) parts.push(`“${f.q.trim()}”`);
  return parts.join(" · ") || t("kind.all");
}

/** Markdown export, grouped by source in reading order. Tags stay inline (`#a/b`), which Obsidian reads as nested tags. */
/** Obsidian embeds: one `![[file]]` per picture; the files go to an `attachments` folder beside the .md. */
export const imageEmbeds = (ids?: string[]) => (ids ?? []).map((id) => `![[${id}]]`);
export const imageIdsOf = (hits: { note: { images?: string[]; anchor?: { thumb?: string } } }[]) => [...new Set(hits.flatMap((h) => [...(h.note.images ?? []), ...(h.note.anchor?.thumb ? [h.note.anchor.thumb] : [])]))];

export function notesToMarkdown(hits: NoteHit[], books: Map<string, BookRecord>, heading: string, relations?: Map<string, string[]>) {
  /** "相关笔记" block after a note: how it is connected to other notes (see `relationsFor`). */
  const rel = (id: string) => (relations?.get(id)?.length ? [`**${t("export.related")}**`, "", ...relations.get(id)!.map((r) => `- ${r}`), ""] : []);
  const sorted = [...hits].sort(
    (x, y) =>
      collate(books.get(x.bookId)?.title ?? "", books.get(y.bookId)?.title ?? "") ||
      x.note.anchor.section - y.note.anchor.section ||
      x.note.anchor.start - y.note.anchor.start,
  );
  const lines = [`# ${heading}`, "", t("export.header", { when: fmtDateTime(new Date()), n: hits.length }), ""];
  const free = hits.filter((h) => h.note.kind === "free").sort((x, y) => y.note.createdAt - x.note.createdAt);
  if (free.length) {
    lines.push(`## ${t("export.free")}`, "");
    for (const { note } of free) lines.push(note.note.trim(), ...(note.images?.length ? ["", ...imageEmbeds(note.images)] : []), "", ...rel(note.id), `<sub>${new Date(note.createdAt).toLocaleString()}</sub>`, "", "---", "");
  }
  let current = "";
  let sectionOpen = false; // inside the 整体笔记 block of the current book
  for (const { bookId, note } of sorted) {
    if (note.kind === "free") continue;
    if (bookId !== current) {
      current = bookId;
      sectionOpen = false;
      const b = books.get(bookId);
      lines.push(`## ${t("kind.bookQuote", { title: b?.title ?? t("kind.removedBook") })}${b?.author ? ` · ${b.author}` : ""}`, "");
    }
    if (note.kind === "doc") {
      if (!sectionOpen) lines.push(`### ${t("export.docNotes")}`, "");
      sectionOpen = true;
      lines.push(note.note.trim(), ...(note.images?.length ? ["", ...imageEmbeds(note.images)] : []), "", ...rel(note.id), `<sub>${new Date(note.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
      continue;
    }
    if (sectionOpen) lines.push(`### ${t("export.excerpts")}`, "");
    sectionOpen = false;
    if (note.anchor.region) lines.push(...(note.anchor.thumb ? [...imageEmbeds([note.anchor.thumb]), ""] : []), note.anchor.image ? `> ${t("kind.imageRegion")}` : `> ${t("kind.pageRegion", { page: note.anchor.section + 1 })}`, "");
    else lines.push(`> ${note.anchor.exact.trim().replace(/\n+/g, "\n> ")}`, "");
    if (note.note.trim()) lines.push(note.note.trim(), "");
    if (note.images?.length) lines.push(...imageEmbeds(note.images), "");
    lines.push(...rel(note.id));
    lines.push(`<sub>${swatch(note.color).name} · ${styleName(note.style)} · ${new Date(note.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
  }
  return lines.join("\n");
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
