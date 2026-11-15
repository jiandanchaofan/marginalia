import type { RefMatch, RefRecognizer, RefTarget } from "../../host/sdk";
import { bookInfo } from "./books";
import { NAME_INDEX, norm } from "./names";
import { currentVersion, docIdOf } from "./ids";
import { BUNDLED, loadPack } from "./packs";

export interface ParsedRef {
  book: string;
  chapter?: number;
  verse?: number;
  verseEnd?: number;
}

/** What a person types for a place in the Bible -> book, chapter, verses. "约 3:16", "约翰福音3章16-18节", "Rom 8:28", "诗23". */
export function parseRef(input: string): ParsedRef | null {
  const s = norm(input);
  if (!s) return null;
  const hit = NAME_INDEX.find((n) => s.startsWith(n.name) && !/^[a-z]/.test(s.slice(n.name.length)));
  if (!hit) return null;
  const info = bookInfo(hit.book)!;
  const rest = s.slice(hit.name.length).replace(/^\./, "").replace(/节$/, "").replace(/篇$/, "章");
  if (!rest) return { book: hit.book };
  let m = /^(\d+)(?:章|:|\.)?$/.exec(rest);
  if (m) {
    const n = +m[1];
    // a book of one chapter: the number is the verse ("犹24")
    if (info.chapters === 1) return n >= 1 ? { book: hit.book, chapter: 1, verse: n } : null;
    return n >= 1 && n <= info.chapters ? { book: hit.book, chapter: n } : null;
  }
  m = /^(\d+)(?:章|:|\.)(\d+)(?:[-至到](\d+))?$/.exec(rest);
  if (m) {
    const [chapter, verse, end] = [+m[1], +m[2], m[3] ? +m[3] : undefined];
    if (chapter < 1 || chapter > info.chapters || verse < 1) return null;
    return { book: hit.book, chapter, verse, ...(end && end > verse ? { verseEnd: end } : {}) };
  }
  m = /^(\d+)[-至到](\d+)$/.exec(rest);
  if (m && info.chapters === 1) {
    const [verse, end] = [+m[1], +m[2]];
    return verse >= 1 ? { book: hit.book, chapter: 1, verse, ...(end > verse ? { verseEnd: end } : {}) } : null;
  }
  return null;
}

/** Canonical position: JHN.3.16, JHN.3.16-18, JHN.3, JHN. */
export const refString = (p: ParsedRef) =>
  [p.book, p.chapter, p.verse !== undefined ? (p.verseEnd ? `${p.verse}-${p.verseEnd}` : p.verse) : undefined].filter((x) => x !== undefined).join(".");

function targetOf(p: ParsedRef): RefTarget {
  const version = currentVersion(BUNDLED.map((b) => b.id));
  const pack = BUNDLED.find((b) => b.id === version) ?? BUNDLED[0];
  const info = bookInfo(p.book)!;
  const zh = pack.lang.startsWith("zh");
  const name = zh ? info.zh : info.en;
  const place = p.chapter === undefined ? "" : p.verse === undefined ? ` ${p.chapter}` : ` ${p.chapter}:${p.verse}${p.verseEnd ? `-${p.verseEnd}` : ""}`;
  return {
    docId: docIdOf(pack.id, p.book),
    title: name,
    label: `${name}${place}`,
    sub: pack.name,
    section: (p.chapter ?? 1) - 1,
    fragment: p.chapter === undefined ? undefined : p.verse === undefined ? `ch${p.chapter}` : `v${p.chapter}-${p.verse}`,
    ref: refString(p),
  };
}

/** What the command palette offers for what was typed: the place itself, or the books whose names start with it. */
export function lookup(query: string): RefTarget[] {
  const exact = parseRef(query);
  if (exact) return [targetOf(exact)];
  const s = norm(query);
  if (!s || /\d/.test(s) || s.length > 20) return [];
  const books = new Set<string>();
  for (const n of NAME_INDEX) if (n.name.startsWith(s) && n.name !== s) books.add(n.book);
  return [...books].slice(0, 6).map((book) => targetOf({ book }));
}

/** References inside a piece of text, as "约 3:16" or "Rom 8:28-30". */
export function find(text: string): RefMatch[] {
  const out: RefMatch[] = [];
  const re = /([一-鿿]{1,7}|(?:[1-3]|I{1,3})?\s?[A-Za-z]{2,14}\.?)\s*(\d{1,3})\s*(?:[:：.章]\s*(\d{1,3})\s*(?:[-–至到]\s*(\d{1,3}))?\s*节?)/g;
  for (const m of text.matchAll(re)) {
    const body = m[0];
    // the book name is the end of what came before the numbers; cut words off the front until it is one
    for (let cut = 0; cut < m[1].length; cut++) {
      const candidate = body.slice(cut);
      const p = parseRef(candidate);
      if (p && p.chapter !== undefined && p.verse !== undefined) {
        const start = (m.index ?? 0) + cut;
        out.push({ start, end: start + candidate.length, ref: refString(p), label: candidate.trim() });
        break;
      }
    }
  }
  return out;
}

/** The words of a reference in the translation in use, for a hover card. */
export async function preview(ref: string): Promise<{ title: string; html: string } | null> {
  const [book, c, v] = ref.split(".");
  const info = bookInfo(book);
  if (!info || !c) return null;
  const pack = await loadPack(currentVersion(BUNDLED.map((b) => b.id)));
  const [from, to] = (v ?? "").split("-").map(Number);
  const rows = (pack.books[book] ?? []).filter((r) => r[0] === +c && r[1] > 0 && (!from || (r[1] >= from && r[1] <= (to || from))));
  if (!rows.length) return null;
  const zh = pack.lang.startsWith("zh");
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return { title: `${zh ? info.zh : info.en} ${c}${v ? ":" + v : ""} · ${pack.name}`, html: rows.map((r) => `<p><sup>${r[1]}</sup> ${esc(r[3])}</p>`).join("") };
}

export const recognizer: RefRecognizer = { id: "bible", find, lookup, preview };
