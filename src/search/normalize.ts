/**
 * Text for the book index and for the search box go through the same cleaning, so they meet:
 * whitespace collapsed, and no space between two CJK characters (line breaks often split Chinese text).
 */
const CJK = "\\u2e80-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
const GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g");

export const normText = (s: string) => s.replace(/\s+/g, " ").replace(GAP, "$1").trim();

/** Paragraphs → chunks of about `max` characters, never cutting a paragraph (a very long one is cut at sentence ends). */
export function chunkParagraphs(paragraphs: string[], max = 520): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) out.push(normText(cur)); // paragraphs were joined with a space: take it out between CJK characters
    cur = "";
  };
  for (const raw of paragraphs) {
    const p = normText(raw);
    if (!p) continue;
    if (p.length > max * 2) {
      push();
      for (const piece of p.match(/[^。！？!?；;.\n]+[。！？!?；;.]*/g) ?? [p]) {
        if (cur.length + piece.length > max) push();
        cur += (cur ? " " : "") + piece;
      }
      push();
      continue;
    }
    if (cur && cur.length + p.length > max) push();
    cur += (cur ? " " : "") + p;
  }
  push();
  return out;
}
