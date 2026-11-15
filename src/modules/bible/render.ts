import { bookInfo } from "./books";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

type Row = [number, number, number, string];

/** Another translation shown under each verse of the main one. */
export interface Alt {
  label: string;
  rows: Row[];
}

/** The words of verses `from..to` of a chapter in another translation ("" when that translation has none). */
export function altText(rows: Row[], chapter: number, from: number, to: number): string {
  const found = rows.filter((r) => r[0] === chapter && r[1] > 0 && r[1] <= to && r[2] >= from);
  return found.map((r) => r[3]).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * One chapter as HTML. Every verse is a span that carries its canonical position (`data-ref="JHN.3.16"`).
 * The verse number is an empty element drawn by CSS from `data-n`: it can be clicked, but it is not part of the text
 * that notes anchor to. With `alts` each verse is its own paragraph and the other translations are drawn under it
 * from `data-alt` (also not part of the text).
 */
export function chapterHtml(bookId: string, chapter: number, rows: Row[], lang: string, alts: Alt[] = [], side = false): string {
  const info = bookInfo(bookId);
  const name = info ? (lang.startsWith("zh") ? info.zh : info.en) : bookId;
  const out: string[] = [`<h2 class="bible-ch" id="ch${chapter}">${esc(`${name} ${chapter}`)}</h2>`];
  const verses: string[] = [];
  for (const [c, v, end, text] of rows) {
    if (c !== chapter) continue;
    if (v === 0) {
      out.push(`<p class="bible-heading">${esc(text)}</p>`);
      continue;
    }
    const ref = `${bookId}.${chapter}.${v}${end > v ? "-" + end : ""}`;
    const n = end > v ? `${v}-${end}` : String(v);
    for (let k = v + 1; k <= end; k++) verses.push(`<i id="v${chapter}-${k}"></i>`);
    const alt = side ? "" : alts.map((a) => `${a.label}  ${altText(a.rows, chapter, v, end) || "（此译本无此节）"}`).join("\n");
    const span = `<span class="v" id="v${chapter}-${v}" data-ref="${ref}"${alt ? ` data-alt="${escAttr(alt)}"` : ""}><b class="vn" data-n="${n}" data-ref-click aria-hidden="true"></b>${esc(text).replace(/\n/g, "<br>")}</span>`;
    if (side && alts[0]) {
      // two columns, one row per verse; the right one is drawn from data-alt, with a verse number that can be clicked too
      const a = alts[0];
      const words = altText(a.rows, chapter, v, end) || "（此译本无此节）";
      verses.push(`<div class="bible-pv">${span} <span class="alt" data-ref-alt="${ref}" data-alt="${escAttr(words)}" data-label="${escAttr(a.label)}"><b class="vn" data-n="${n}" data-ref-click aria-hidden="true"></b></span></div>`);
    } else {
      // a space after every verse keeps the page text the same whichever way translations are compared
      verses.push(alts.length ? `<p class="bible-v">${span} </p>` : span);
    }
  }
  out.push(alts.length ? verses.join("") : `<p class="bible-text">${verses.join(" ")}</p>`);
  return out.join("");
}
