// Turns translations in USFM into scripture packs: one small file per translation, plus a manifest.
//   node scripts/scripture-pack.mjs <outDir> <id>=<usfm dir>|<name>|<lang>|<license>|<source> ...
// A pack is gzip-compressed JSON in the format the app imports (also what a user's own translation is converted
// to). Only texts that may be redistributed are packed here.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BOOKS, readUsfmDir } from "./scripture-usfm.mjs";

export const PACK_FORMAT = "marginalia-scripture-1";

/** The JSON of a pack: books -> [chapter, verse, verseEnd, text] rows; verse 0 is a heading some psalms carry. */
export function makePack(meta, books) {
  const out = {};
  for (const b of BOOKS) out[b] = books.get(b).map((v) => [v.chapter, v.verse, v.verseEnd, v.text]);
  return { format: PACK_FORMAT, ...meta, books: out };
}

export const packBytes = (pack) => gzipSync(Buffer.from(JSON.stringify(pack)), { level: 9 });
export const readPack = (bytes) => JSON.parse(gunzipSync(bytes).toString("utf8"));

if (process.argv[1].endsWith("scripture-pack.mjs")) {
  const [outDir, ...specs] = process.argv.slice(2);
  if (!outDir || !specs.length) throw new Error("usage: scripture-pack.mjs outDir id=dir|name|lang|license|source ...");
  mkdirSync(outDir, { recursive: true });
  const manifest = { format: PACK_FORMAT + "/manifest", packs: [] };
  for (const spec of specs) {
    const [head, name, lang, license, source] = spec.split("|");
    const [id, dir] = head.split("=");
    const books = readUsfmDir(dir);
    const missing = BOOKS.filter((b) => !books.has(b));
    if (missing.length) throw new Error(`${id}: missing ${missing.join(",")}`);
    const pack = makePack({ id, name, lang, license, source }, books);
    const bytes = packBytes(pack);
    const file = `${id}.json.gz`;
    writeFileSync(join(outDir, file), bytes);
    // read it back: what the app will see must be what was meant
    const back = readPack(readFileSync(join(outDir, file)));
    const rows = Object.values(back.books).reduce((n, l) => n + l.length, 0);
    manifest.packs.push({ id, name, lang, license, source, file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), verses: rows });
    console.log(`${id}: ${rows} rows, ${(bytes.length / 1024).toFixed(0)} KB`);
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("wrote manifest.json");
}
