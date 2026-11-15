import { bookInfo } from "./books";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Row = [number, number, number, string];

/**
 * One chapter as HTML. Every verse is a span that carries its canonical position (`data-ref="JHN.3.16"`);
 * the verse number is drawn by CSS from `data-n`, so it is not part of the text that notes anchor to.
 */
export function chapterHtml(bookId: string, chapter: number, rows: Row[], lang: string): string {
  const info = bookInfo(bookId);
  const name = info ? (lang.startsWith("zh") ? info.zh : info.en) : bookId;
  const title = lang.startsWith("zh") ? `${name} ${chapter}` : `${name} ${chapter}`;
  const out: string[] = [`<h2 class="bible-ch" id="ch${chapter}">${esc(title)}</h2>`];
  const verses: string[] = [];
  for (const [c, v, end, text] of rows) {
    if (c !== chapter) continue;
    if (v === 0) {
      out.push(`<p class="bible-heading">${esc(text)}</p>`);
      continue;
    }
    const ref = `${bookId}.${chapter}.${v}${end > v ? "-" + end : ""}`;
    const n = end > v ? `${v}-${end}` : String(v);
    verses.push(`<span class="v" id="v${chapter}-${v}" data-ref="${ref}" data-n="${n}">${esc(text).replace(/\n/g, "<br>")}</span>`);
  }
  out.push(`<p class="bible-text">${verses.join(" ")}</p>`);
  return out.join("");
}
