/** Editing helpers for the light note formatting (see format.ts). Pure functions: (text, selection) → new text + selection. */

export interface Edit {
  value: string;
  start: number;
  end: number;
}

export type FormatKind = "b" | "i" | "u" | "s" | "ul" | "ol" | "todo";

const MARKS: Record<"b" | "i" | "u" | "s", [string, string]> = {
  b: ["**", "**"],
  i: ["*", "*"],
  u: ["<u>", "</u>"],
  s: ["~~", "~~"],
};

/** Italic is a single `*`, which must not be confused with the `**` of bold: only an odd run of stars counts as italic. */
function toggleStar(value: string, start: number, end: number): Edit {
  const sel = value.slice(start, end);
  const run = (re: RegExp, s: string) => (re.exec(s)?.[0].length ?? 0);
  const before = run(/\*+$/, value.slice(0, start));
  const after = run(/^\*+/, value.slice(end));
  if (before % 2 === 1 && after % 2 === 1) return { value: value.slice(0, start - 1) + sel + value.slice(end + 1), start: start - 1, end: end - 1 };
  const lead = run(/^\*+/, sel);
  const trail = run(/\*+$/, sel);
  if (lead % 2 === 1 && trail % 2 === 1 && sel.length > lead + trail - 1 && sel.length >= 3) {
    const inner = sel.slice(1, sel.length - 1);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  return { value: value.slice(0, start) + "*" + sel + "*" + value.slice(end), start: start + 1, end: end + 1 };
}

/** Wrap the selection in `open`/`close`; wrapped already → unwrap; nothing selected → drop a pair and sit between. */
export function toggleWrap(value: string, start: number, end: number, open: string, close: string): Edit {
  if (open === "*" && close === "*") return toggleStar(value, start, end);
  const sel = value.slice(start, end);
  // markers just outside the selection
  if (start >= open.length && value.slice(start - open.length, start) === open && value.slice(end, end + close.length) === close) {
    return { value: value.slice(0, start - open.length) + sel + value.slice(end + close.length), start: start - open.length, end: end - open.length };
  }
  // markers inside the selection
  if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  return { value: value.slice(0, start) + open + sel + close + value.slice(end), start: start + open.length, end: end + open.length };
}

const PREFIX = /^(?:[-•] (?:\[[ xX]\] ?)?|\d{1,3}\. )/;

/** Turn the lines touched by the selection into a bullet / numbered list, or back into plain lines when they already are one. */
export function toggleList(value: string, start: number, end: number, ordered: boolean): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  let to = value.indexOf("\n", end);
  if (to < 0) to = value.length;
  const lines = value.slice(from, to).split("\n");
  const has = (l: string) => (ordered ? /^\d{1,3}\. /.test(l) : /^[-•] /.test(l));
  const filled = lines.filter((l) => l.trim());
  const allOn = filled.length > 0 && filled.every(has);
  let n = 0;
  const next = lines.map((l) => {
    const bare = l.replace(PREFIX, "");
    if (allOn) return bare;
    if (!l.trim() && filled.length) return l; // blank lines between items stay blank; a lone empty line gets its marker
    return ordered ? `${++n}. ${bare}` : `- ${bare}`;
  });
  const block = next.join("\n");
  const out = value.slice(0, from) + block + value.slice(to);
  if (start === end) {
    // a plain caret stays where it was (shifted by the marker added / removed), so typing continues after the marker
    const caret = Math.max(from, start + next[0].length - lines[0].length);
    return { value: out, start: caret, end: caret };
  }
  return { value: out, start: from, end: from + block.length };
}

const TODO_PREFIX = /^(\s*)- \[[ xX]\] ?/;

/** Turn the lines touched by the selection into todo lines (`- [ ] `), or back into plain lines when they all are todos. */
export function toggleTodo(value: string, start: number, end: number): Edit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  let to = value.indexOf("\n", end);
  if (to < 0) to = value.length;
  const lines = value.slice(from, to).split("\n");
  const filled = lines.filter((l) => l.trim());
  const allOn = filled.length > 0 && filled.every((l) => TODO_PREFIX.test(l));
  const next = lines.map((l) => {
    if (allOn) return l.replace(TODO_PREFIX, "$1");
    if (!l.trim() && filled.length) return l;
    const indent = /^\s*/.exec(l)![0];
    const bare = l.slice(indent.length).replace(PREFIX, "");
    return `${indent}- [ ] ${bare}`;
  });
  const block = next.join("\n");
  const out = value.slice(0, from) + block + value.slice(to);
  if (start === end) {
    const caret = Math.max(from, start + next[0].length - lines[0].length);
    return { value: out, start: caret, end: caret };
  }
  return { value: out, start: from, end: from + block.length };
}

/** Tab / Shift+Tab on todo lines: one nesting level (two spaces) deeper / shallower. Null when no selected line is a todo. */
export function indentTodo(value: string, start: number, end: number, outdent: boolean): Edit | null {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  let to = value.indexOf("\n", end);
  if (to < 0) to = value.length;
  const lines = value.slice(from, to).split("\n");
  if (!lines.some((l) => TODO_PREFIX.test(l))) return null;
  const delta: number[] = [];
  const next = lines.map((l) => {
    if (!TODO_PREFIX.test(l)) return (delta.push(0), l);
    if (!outdent) return (delta.push(2), "  " + l);
    const cut = /^(?: {1,2}|\t)/.exec(l)?.[0].length ?? 0;
    delta.push(-cut);
    return l.slice(cut);
  });
  const block = next.join("\n");
  const out = value.slice(0, from) + block + value.slice(to);
  if (start === end) {
    const caret = Math.max(from, start + delta[0]);
    return { value: out, start: caret, end: caret };
  }
  return { value: out, start: from, end: from + block.length };
}

/** Flip `[ ]` / `[x]` on one line of a note (what clicking a checkbox does). Unchanged when that line is not a todo. */
export function toggleTodoLine(text: string, line: number): string {
  const lines = text.split("\n");
  const l = lines[line];
  const m = l === undefined ? null : /^(\s*- \[)([ xX])(\].*)$/.exec(l);
  if (!m) return text;
  lines[line] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
  return lines.join("\n");
}

export function applyFormat(value: string, start: number, end: number, kind: FormatKind): Edit {
  if (kind === "todo") return toggleTodo(value, start, end);
  if (kind === "ul" || kind === "ol") return toggleList(value, start, end, kind === "ol");
  const [o, c] = MARKS[kind];
  return toggleWrap(value, start, end, o, c);
}

/** Enter inside a list line: continue the list (numbers count up); Enter on an empty item ends the list. Null = not a list line. */
export function continueList(value: string, caret: number): Edit | null {
  const from = value.lastIndexOf("\n", caret - 1) + 1;
  let to = value.indexOf("\n", caret);
  if (to < 0) to = value.length;
  const line = value.slice(from, to);
  // a todo line: keep the nesting, start the next one unchecked; an empty todo ends the list
  const t = /^(\s*)- \[[ xX]\] ?(.*)$/.exec(line);
  if (t && caret >= from + t[1].length + 5) {
    if (!t[2].trim()) return { value: value.slice(0, from) + t[1] + value.slice(to), start: from + t[1].length, end: from + t[1].length };
    const ins = `\n${t[1]}- [ ] `;
    return { value: value.slice(0, caret) + ins + value.slice(caret), start: caret + ins.length, end: caret + ins.length };
  }
  const m = /^([-•] |(\d{1,3})\. )(.*)$/.exec(line);
  if (!m || caret < from + m[1].length) return null;
  if (!m[3].trim()) {
    // empty item: remove the marker, leaving a plain empty line
    return { value: value.slice(0, from) + value.slice(to), start: from, end: from };
  }
  const marker = m[2] ? `${Number(m[2]) + 1}. ` : m[1];
  const ins = "\n" + marker;
  return { value: value.slice(0, caret) + ins + value.slice(caret), start: caret + ins.length, end: caret + ins.length };
}
