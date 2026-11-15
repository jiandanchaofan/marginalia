// Builds the read-only scripture database (plugins/org.marginalia.bible/scripture.db) from public-domain USFM.
//   node scripts/build-scripture.mjs <out.db> <id>=<usfm dir>|<name>|<lang> ...
// e.g. cuv-hans=./cmn-cu89s|和合本（简体）|zh-Hans  web=./engwebp|World English Bible|en
// Only texts that may be redistributed belong in a bundled database; see docs/bible-module-prep.md.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BOOKS, readUsfmDir } from "./scripture-usfm.mjs";

const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) throw new Error("usage: build-scripture.mjs out.db id=dir|name|lang ...");
if (existsSync(out)) rmSync(out);

const db = new DatabaseSync(out);
db.exec(`
CREATE TABLE versions(id TEXT PRIMARY KEY, name TEXT NOT NULL, lang TEXT NOT NULL, is_bundled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE books(id TEXT PRIMARY KEY, ord INTEGER NOT NULL, testament TEXT NOT NULL, name_zh TEXT, abbr_zh TEXT, name_en TEXT, abbr_en TEXT, chapters INTEGER NOT NULL);
CREATE TABLE verses(
  version_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,          -- 0 = the heading some psalms carry
  verse_end INTEGER NOT NULL,      -- = verse, or the last verse of a combined entry (a translation may print "3-4" as one)
  text TEXT NOT NULL,
  PRIMARY KEY(version_id, book_id, chapter, verse)
);
`);

const names = (dir) => {
  const m = new Map();
  for (const f of readdirSync(dir).filter((n) => /\.(usfm|sfm)$/i.test(n))) {
    const raw = readFileSync(join(dir, f), "utf8").replace(/^﻿/, "");
    const id = /^\\id\s+([A-Z0-9]{3})/m.exec(raw)?.[1];
    if (!id) continue;
    m.set(id, { name: /^\\toc1\s+(.+)$/m.exec(raw)?.[1]?.trim(), abbr: /^\\toc3\s+(.+)$/m.exec(raw)?.[1]?.trim() });
  }
  return m;
};

const insertVersion = db.prepare("INSERT INTO versions(id, name, lang, is_bundled) VALUES(?, ?, ?, 1)");
const insertVerse = db.prepare("INSERT INTO verses(version_id, book_id, chapter, verse, verse_end, text) VALUES(?, ?, ?, ?, ?, ?)");
let zh = new Map(), en = new Map(), chapters = new Map();
db.exec("BEGIN");
for (const spec of specs) {
  const [head, name, lang] = spec.split("|");
  const [id, dir] = head.split("=");
  const books = readUsfmDir(dir);
  const missing = BOOKS.filter((b) => !books.has(b));
  if (missing.length) throw new Error(`${id}: missing ${missing.join(",")}`);
  insertVersion.run(id, name, lang);
  let n = 0;
  for (const b of BOOKS) {
    for (const v of books.get(b)) {
      insertVerse.run(id, b, v.chapter, v.verse, v.verseEnd, v.text);
      chapters.set(b, Math.max(chapters.get(b) ?? 0, v.chapter));
      n++;
    }
  }
  if (lang.startsWith("zh") && !zh.size) zh = names(dir);
  if (lang === "en" && !en.size) en = names(dir);
  console.log(`${id}: ${n} rows`);
}
const insertBook = db.prepare("INSERT INTO books(id, ord, testament, name_zh, abbr_zh, name_en, abbr_en, chapters) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
BOOKS.forEach((b, i) => insertBook.run(b, i + 1, i < 39 ? "OT" : "NT", zh.get(b)?.name ?? null, zh.get(b)?.abbr ?? null, en.get(b)?.name ?? null, en.get(b)?.abbr ?? null, chapters.get(b)));
db.exec("COMMIT");
// full-text search over every translation (trigram: works for Chinese without a word list)
db.exec(`
CREATE VIRTUAL TABLE verses_fts USING fts5(text, content='verses', content_rowid='rowid', tokenize='trigram');
INSERT INTO verses_fts(verses_fts) VALUES('rebuild');
CREATE INDEX verses_pos ON verses(book_id, chapter, verse);
PRAGMA user_version = 1;
`);
db.exec("VACUUM");
db.close();
console.log("wrote", out);
