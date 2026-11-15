// Checks translations read from USFM: every book there, chapter / verse counts, empty verses,
// and where the translations number their verses differently (the input to the verse mapping table).
//   node scripts/scripture-check.mjs <name>=<dir> [<name>=<dir> ...]
import { BOOKS, readUsfmDir } from "./scripture-usfm.mjs";

const args = process.argv.slice(2).map((a) => a.split("="));
if (args.length < 1) throw new Error("usage: scripture-check.mjs name=dir ...");
const data = new Map(args.map(([name, dir]) => [name, readUsfmDir(dir)]));

// chapter -> highest verse, per translation
const shape = new Map();
for (const [name, books] of data) {
  const s = new Map();
  let verses = 0, empty = 0, bridges = 0, chapters = 0;
  const missing = BOOKS.filter((b) => !books.has(b));
  for (const [book, list] of books) {
    const ch = new Map();
    for (const v of list) {
      if (v.verse === 0) continue;
      verses++;
      if (!v.text) empty++;
      if (v.verseEnd > v.verse) bridges++;
      ch.set(v.chapter, Math.max(ch.get(v.chapter) ?? 0, v.verseEnd));
    }
    chapters += ch.size;
    s.set(book, ch);
  }
  shape.set(name, s);
  console.log(`${name}: ${books.size} books${missing.length ? " (missing " + missing.join(",") + ")" : ""}, ${chapters} chapters, ${verses} verses, ${empty} empty, ${bridges} bridged`);
}

const names = [...data.keys()];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const [a, b] = [names[i], names[j]];
    const diffs = [];
    for (const book of BOOKS) {
      const x = shape.get(a).get(book), y = shape.get(b).get(book);
      if (!x || !y) continue;
      for (const c of new Set([...x.keys(), ...y.keys()])) {
        const m = x.get(c), n = y.get(c);
        if (m !== n) diffs.push(`${book} ${c}: ${a}=${m ?? "-"} ${b}=${n ?? "-"}`);
      }
    }
    console.log(`\n${a} vs ${b}: ${diffs.length} chapters differ in size`);
    for (const d of diffs.slice(0, 60)) console.log("  " + d);
    if (diffs.length > 60) console.log(`  ... and ${diffs.length - 60} more`);
  }
}
