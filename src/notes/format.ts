/**
 * Light inline formatting kept as plain text in the note (so search, tags, export and backups all keep working):
 *   **bold**   *italic*   <u>underline</u>   ~~strikethrough~~
 *   "- " bullet lines and "1. " numbered lines
 * Everything here is parsed into a small tree and rendered as React nodes (never as raw HTML).
 */

export type InlineKind = "b" | "i" | "u" | "s";
export type Inline = { t: "text"; v: string } | { t: "math"; v: string } | { t: InlineKind; c: Inline[] };
export interface TodoItem {
  done: boolean;
  /** Nesting level (two spaces per level). */
  indent: number;
  /** Text after the checkbox, still containing its `@plan` / `截止:` / `!priority` tokens. */
  text: string;
  /** Line number in the note (what a click on the checkbox has to flip). */
  line: number;
}
export type Block = { kind: "p"; text: string } | { kind: "math"; tex: string } | { kind: "ul" | "ol"; items: string[]; start?: number } | { kind: "todo"; items: TodoItem[] };

import { matchTodo } from "../tasks/parse";

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
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    // Display math: `$$ ... $$` on one line, or opened by a `$$` line and closed by a line ending in `$$`.
    if (line.trimStart().startsWith("$$")) {
      const first = line.trimStart().slice(2);
      let tex: string | null = null;
      let last = lineNo;
      if (first.trimEnd().endsWith("$$") && first.trim().length > 2) tex = first.trimEnd().slice(0, -2);
      else
        for (let k = lineNo + 1; k < lines.length; k++) {
          if (lines[k].trimEnd().endsWith("$$")) {
            tex = [first, ...lines.slice(lineNo + 1, k), lines[k].trimEnd().slice(0, -2)].join("\n");
            last = k;
            break;
          }
        }
      if (tex !== null && tex.trim()) {
        flush();
        blocks.push({ kind: "math", tex: tex.trim() });
        lineNo = last;
        continue;
      }
    }
    const todo = matchTodo(line);
    if (todo) {
      flush();
      const last = blocks[blocks.length - 1];
      const item = { done: todo.done, indent: todo.indent, text: todo.text, line: lineNo };
      if (last && last.kind === "todo") last.items.push(item);
      else blocks.push({ kind: "todo", items: [item] });
      continue;
    }
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

/** End of an inline `$...$` that opens at `from` (the char after the `$`), or -1. Like pandoc: no space just inside, and no digit right after the closing `$`, so "$5 and $10" stays text. */
function closeMath(s: string, from: number): number {
  if (from >= s.length || /\s/.test(s[from])) return -1;
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "\n") return -1;
    if (s[j] === "$") return j > from && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] ?? "") ? j : -1;
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
    if (s[i] === "\\" && s[i + 1] === "$") {
      text += "$"; // \$ is a literal dollar sign
      i += 2;
      continue;
    }
    if (s[i] === "$" && s[i + 1] !== "$") {
      const end = closeMath(s, i + 1);
      if (end > 0) {
        pushText();
        out.push({ t: "math", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
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

/** Does the note contain a LaTeX formula (inline `$..$` or display `$$..$$`)? */
export function hasMath(text: string): boolean {
  if (!text.includes("$")) return false;
  const inline = (nodes: Inline[]): boolean => nodes.some((n) => n.t === "math" || (n.t !== "text" && inline(n.c)));
  return parseBlocks(text).some((b) => {
    if (b.kind === "math") return true;
    if (b.kind === "p") return inline(parseInline(b.text));
    if (b.kind === "todo") return b.items.some((it) => inline(parseInline(it.text)));
    return b.items.some((it) => inline(parseInline(it)));
  });
}
