// Reads a Bible translation in USFM (the format eBible.org publishes) into plain verses.
// Shared by the build script and the checks; no dependencies. See docs/bible-module-prep.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The 66 books of the Protestant canon in order, with USFM / Paratext ids (also used in canonical refs: JHN.3.16). */
export const BOOKS = `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.split(" ");

/** Strip USFM markup from the text of one verse (or the rest of a line), keeping the words. */
export function clean(s) {
  return s
    .replace(/\\f\s.*?\\f\*/gs, "") // footnotes
    .replace(/\\x\s.*?\\x\*/gs, "") // cross references
    .replace(/\\fig\s.*?\\fig\*/gs, "")
    .replace(/\\\+?w\s+([^|\\]*?)(\|[^\\]*)?\\\+?w\*/g, "$1") // \w word|strong="G1"\w*
    .replace(/\\\+?[a-z]+\d*\*?/gi, "") // every other marker; the text between stays
    .replace(/¶/g, " ") // a pilcrow some editions print for a paragraph start
    .replace(/\s+/g, " ")
    // Chinese is written without spaces; the sources leave some around honorific marks and removed notes
    .replace(/(?<=[　-鿿＀-￯「」『』])\s+(?=[　-鿿＀-￯「」『』])/g, "")
    .trim();
}

/** @returns {Map<string, {chapter:number, verse:number, verseEnd:number, text:string}[]>} book id -> verses in order */
export function readUsfmDir(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".usfm") || n.toLowerCase().endsWith(".sfm"))) {
    const raw = readFileSync(join(dir, f), "utf8").replace(/^﻿/, "");
    const id = /^\\id\s+([A-Z0-9]{3})/m.exec(raw)?.[1];
    if (!id || !BOOKS.includes(id)) continue; // front matter, apocrypha
    const verses = [];
    let chapter = 0;
    let cur = null;
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
      } else if (tag === "v") {
        flush();
        const v = /^(\d+)(?:-(\d+))?[a-z]?\s*(.*)$/s.exec(rest);
        if (!v) continue;
        cur = { chapter, verse: +v[1], verseEnd: v[2] ? +v[2] : +v[1], parts: [(/^q\d?$/.test(tag) ? "\n" : "") + v[3]] };
      } else if (/^(q\d?|p|m|pi\d?|mi|nb|li\d?)$/.test(tag)) {
        // poetry and paragraphs: remember the line break inside the verse that continues
        if (cur) cur.parts.push((/^q/.test(tag) ? "\n" : " ") + rest);
      } else if (/^(s\d?|r|d|ms\d?|mr|sp|b|cl|cd|h|toc\d|mt\d?|ide|id|rem|sts|lit|iex|ie|imt\d?|ip|is\d?|io\d?)$/.test(tag)) {
        // headings, titles, introductions: not verse text (psalm superscriptions \d are kept apart for now)
        if (tag === "d" && cur === null && chapter) verses.push({ chapter, verse: 0, verseEnd: 0, text: clean(rest) });
      } else if (cur) {
        cur.parts.push(rest);
      }
    }
    flush();
    out.set(id, verses);
  }
  return out;
}
