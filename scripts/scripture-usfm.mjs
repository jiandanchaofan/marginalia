// Reads a Bible translation in USFM (the format eBible.org publishes) into plain verses.
// Shared by the build script and the checks; no dependencies. See docs/bible-module-prep.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The 66 books of the Protestant canon in order, with USFM / Paratext ids (also used in canonical refs: JHN.3.16). */
export const BOOKS = `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.split(" ");

// Han characters, fullwidth forms and the corner brackets: Chinese is written without spaces between them
const CJK = "\\u3000-\\u9fff\\uff00-\\uffef\\u300c\\u300d\\u300e\\u300f";
const CJK_GAP = new RegExp(`(?<=[${CJK}])[^\\S\\n]+(?=[${CJK}])`, "g");

/** Strip USFM markup from the text of one verse (or the rest of a line), keeping the words and the line breaks of poetry. */
export function clean(s) {
  return s
    .replace(/\\f\s.*?\\f\*/gs, "") // footnotes
    .replace(/\\x\s.*?\\x\*/gs, "") // cross references
    .replace(/\\fig\s.*?\\fig\*/gs, "")
    .replace(/\\\+?w\s+([^|\\]*?)(\|[^\\]*)?\\\+?w\*/g, "$1") // \w word|strong="G1"\w*
    .replace(/\\\+?[a-z]+\d*\*?/gi, "") // every other marker; the text between stays
    .replace(/¶/g, " ") // a pilcrow some editions print for a paragraph start
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n") // a line break of poetry stays one line break
    .replace(CJK_GAP, "") // the sources leave spaces around honorific marks and removed notes
    .trim();
}

/**
 * @returns {Map<string, {chapter:number, verse:number, verseEnd:number, text:string, par:number}[]>} book id -> verses in order.
 * `par` says how a verse starts: 0 inside a paragraph, 1 a new prose paragraph, 2 a new block of poetry, 3 a new line of poetry.
 * `xref` is the line of parallel passages printed above the paragraph, if the source has one.
 */
export function readUsfmDir(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".usfm") || n.toLowerCase().endsWith(".sfm"))) {
    const raw = readFileSync(join(dir, f), "utf8").replace(/^﻿/, "");
    const id = /^\\id\s+([A-Z0-9]{3})/m.exec(raw)?.[1];
    if (!id || !BOOKS.includes(id)) continue; // front matter, apocrypha
    const verses = [];
    let chapter = 0;
    let cur = null;
    let pending = 0; // how the next verse starts, from the paragraph marker before it
    let lastKind = "";
    let blank = false;
    let xref = ""; // the parallel passages printed under a heading ("太3·1—12；可1·1—8"), kept for the verse that follows
    const flush = () => {
      if (cur) {
        cur.text = clean(cur.parts.join(" "));
        delete cur.parts;
        verses.push(cur);
        cur = null;
      }
    };
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\\([a-z0-9]+)\*?\s?(.*)$/i.exec(line);
      if (!m) {
        if (cur && line.trim()) cur.parts.push(line);
        continue;
      }
      const [, tag, rest] = m;
      if (tag === "c") {
        flush();
        chapter = parseInt(rest, 10);
        pending = 1;
        lastKind = "p";
      } else if (tag === "v") {
        flush();
        const v = /^(\d+)(?:-(\d+))?[a-z]?\s*(.*)$/s.exec(rest);
        if (!v) continue;
        cur = { chapter, verse: +v[1], verseEnd: v[2] ? +v[2] : +v[1], par: pending, xref, parts: [v[3]] };
        pending = 0;
        xref = "";
      } else if (/^(q\d?|p|m|pi\d?|mi|nb|li\d?|pc|pr|cls)$/.test(tag)) {
        // how the next verse starts: a line of poetry (the first of a block after a blank line or prose, else a further
        // line) or a new paragraph; `nb` goes on without a break
        if (/^q/.test(tag)) {
          pending = lastKind === "q" && !blank ? 3 : 2;
          lastKind = "q";
          blank = false;
        } else if (tag === "nb") pending = 0;
        else {
          pending = 1;
          lastKind = "p";
        }
        // poetry and paragraphs: remember the line break inside the verse that continues
        if (cur) cur.parts.push((/^q/.test(tag) ? "\n" : " ") + rest);
      } else if (/^(s\d?|r|d|ms\d?|mr|sp|b|cl|cd|h|toc\d|mt\d?|ide|id|rem|sts|lit|iex|ie|imt\d?|ip|is\d?|io\d?)$/.test(tag)) {
        // headings, titles, introductions: not verse text (psalm superscriptions \d are kept apart for now)
        if (tag === "b") blank = true;
        if (tag === "r") xref = clean(rest).replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
        if (/^(s\d?|ms\d?)$/.test(tag)) {
          pending = 1;
          lastKind = "p";
        }
        if (tag === "d" && cur === null && chapter) verses.push({ chapter, verse: 0, verseEnd: 0, text: clean(rest), par: 0, xref: "" });
      } else if (cur) {
        cur.parts.push(rest);
      }
    }
    flush();
    out.set(id, verses);
  }
  return out;
}
