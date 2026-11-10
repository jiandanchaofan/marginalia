/**
 * Light inline formatting kept as plain text in the note (so search, tags, export and backups all keep working):
 *   **bold**   *italic*   <u>underline</u>   ~~strikethrough~~
 *   "- " bullet lines and "1. " numbered lines
 * Everything here is parsed into a small tree and rendered as React nodes (never as raw HTML).
 */

export type InlineKind = "b" | "i" | "u" | "s";
export type Inline = { t: "text"; v: string } | { t: InlineKind; c: Inline[] };
export type Block = { kind: "p"; text: string } | { kind: "ul" | "ol"; items: string[]; start?: number };

const BULLET = /^(?:[-•]) (.*)$/;
const ORDERED = /^(\d{1,3})\. (.*)$/;

/** Split note text into paragraphs (kept verbatim, line breaks included) and list runs. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (const line of text.split("\n")) {
    const b = BULLET.exec(line);
    const o = b ? null : ORDERED.exec(line);
    if (b) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ul") last.items.push(b[1]);
      else blocks.push({ kind: "ul", items: [b[1]] });
    } else if (o) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "ol") last.items.push(o[2]);
      else blocks.push({ kind: "ol", items: [o[2]], start: Number(o[1]) });
    } else para.push(line);
  }
  flush();
  return blocks;
}

/** `*` opens italic only when glued to text on its right, and closes only when glued on its left. */
function closeStar(s: string, from: number): number {
  for (let j = s.indexOf("*", from); j >= 0; j = s.indexOf("*", j + 1)) {
    if (s[j + 1] === "*") {
      j++; // skip a "**" pair inside
      continue;
    }
    if (j > from && !/\s/.test(s[j - 1])) return j;
  }
  return -1;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const pushText = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    let kind: InlineKind | null = null;
    let open = 0;
    let end = -1;
    if (s.startsWith("***", i) && s.indexOf("***", i + 3) > i + 3 && s.slice(i + 3, s.indexOf("***", i + 3)).trim()) {
      // bold + italic written as ***text***
      const end3 = s.indexOf("***", i + 3);
      pushText();
      out.push({ t: "b", c: [{ t: "i", c: parseInline(s.slice(i + 3, end3)) }] });
      i = end3 + 3;
      continue;
    }
    if (s.startsWith("**", i)) {
      kind = "b";
      open = 2;
      end = s.indexOf("**", i + 2);
    } else if (s.startsWith("~~", i)) {
      kind = "s";
      open = 2;
      end = s.indexOf("~~", i + 2);
    } else if (s.startsWith("<u>", i)) {
      kind = "u";
      open = 3;
      end = s.indexOf("</u>", i + 3);
    } else if (s[i] === "*" && s[i + 1] !== undefined && !/[\s*]/.test(s[i + 1])) {
      kind = "i";
      open = 1;
      end = closeStar(s, i + 1);
    }
    if (kind && end > i + open) {
      const inner = s.slice(i + open, end);
      if (inner.trim()) {
        pushText();
        out.push({ t: kind, c: parseInline(inner) });
        i = end + (kind === "u" ? 4 : kind === "i" ? 1 : 2);
        continue;
      }
    }
    text += s[i++];
  }
  pushText();
  return out;
}
