import { bookInfo } from "./books";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

/**
 * [chapter, verse, last verse, text, how it starts, parallel passages]. "How it starts": 0 inside a paragraph, 1 a new
 * prose paragraph, 2 a new block of poetry, 3 a new line of poetry. The parallel passages are the line printed above a
 * paragraph in some editions ("太3·1—12；可1·1—8").
 */
export type Row = [number, number, number, string, number?, string?];

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

const CJK = /[　-鿿]/;

/** The words of a verse as HTML; the line breaks of poetry become <br>, with the space the text had there kept for Latin text. */
function words(text: string): string {
  let out = "";
  const parts = text.split("\n");
  parts.forEach((p, i) => {
    out += esc(p);
    if (i < parts.length - 1) out += (CJK.test(p.slice(-1)) || CJK.test(parts[i + 1].charAt(0)) ? "" : " ") + "<br>";
  });
  return out;
}

/** The parallel passages above a paragraph: real text, but outside the text notes anchor to. */
const xrefLine = (x: string) => `<p class="bible-xref" data-anchor-ignore>（${esc(x)}）</p>`;

/**
 * One chapter as HTML, in paragraphs (poetry in lines) the way the translation is printed. Every verse is a span that
 * carries its canonical position (`data-ref="JHN.3.16"`). The verse number is an empty element drawn by CSS from `data-n`:
 * it can be clicked, but it is not part of the text that notes anchor to. Every verse is followed by one space, in
 * every way of showing the page, so the text of the page is the same whichever way translations are compared. With
 * `alts` each verse is its own block and the other translations are drawn under it from `data-alt` (also not part of the text).
 */
export function chapterHtml(bookId: string, chapter: number, rows: Row[], lang: string, alts: Alt[] = [], side = false): string {
  const info = bookInfo(bookId);
  const name = info ? (lang.startsWith("zh") ? info.zh : info.en) : bookId;
  const out: string[] = [`<h2 class="bible-ch" id="ch${chapter}">${esc(`${name} ${chapter}`)}</h2>`];
  // plain reading: paragraphs of verses; the other ways: a block for each verse
  const groups: { poetry: boolean; xref: string; parts: string[] }[] = [];
  const blocks: string[] = [];
  let seen = 0;
  for (const [c, v, end, text, par = 0, xref = ""] of rows) {
    if (c !== chapter) continue;
    if (v === 0) {
      out.push(`<p class="bible-heading">${esc(text)}</p>`);
      continue;
    }
    const ref = `${bookId}.${chapter}.${v}${end > v ? "-" + end : ""}`;
    const n = end > v ? `${v}-${end}` : String(v);
    const anchors = Array.from({ length: end - v }, (_, i) => `<i id="v${chapter}-${v + 1 + i}"></i>`).join("");
    const alt = side ? "" : alts.map((a) => `${a.label}  ${altText(a.rows, chapter, v, end) || "（此译本无此节）"}`).join("\n");
    const span = `<span class="v" id="v${chapter}-${v}" data-ref="${ref}"${alt ? ` data-alt="${escAttr(alt)}"` : ""}><b class="vn" data-n="${n}" data-ref-click aria-hidden="true"></b>${words(text)}</span>`;
    const starts = seen === 0 || par === 1 || par === 2;
    seen++;
    if (alts.length) {
      const cls = starts ? " par" : "";
      if (xref && starts) blocks.push(xrefLine(xref));
      if (side) {
        const a = alts[0];
        const other = altText(a.rows, chapter, v, end) || "（此译本无此节）";
        blocks.push(`${anchors}<div class="bible-pv${cls}">${span} <span class="alt" data-ref-alt="${ref}" data-alt="${escAttr(other)}" data-label="${escAttr(a.label)}"><b class="vn" data-n="${n}" data-ref-click aria-hidden="true"></b></span></div>`);
      } else {
        blocks.push(`${anchors}<p class="bible-v${cls}${par >= 2 ? " poetry" : ""}">${span} </p>`);
      }
    } else {
      if (starts || !groups.length) groups.push({ poetry: par === 2, xref, parts: [] });
      const g = groups[groups.length - 1];
      if (par === 3 && g.poetry) g.parts.push("<br>");
      g.parts.push(`${anchors}${span} `);
    }
  }
  if (alts.length) out.push(...blocks);
  else for (const g of groups) out.push((g.xref ? xrefLine(g.xref) : "") + `<p class="bible-text${g.poetry ? " poetry" : ""}">${g.parts.join("")}</p>`);
  return out.join("");
}
