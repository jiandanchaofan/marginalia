/**
 * Todo lines inside notes (plain text, Markdown task syntax):
 *
 *   - [ ] 写需求文档 #专题/产品改版 @2026-W47 截止:2026-11-22 !高
 *     - [x] 子任务（缩进两个空格）
 *
 * `@…` is the plan (a day, week, month or year), `截止:` the deadline, `!高/!中/!低` the priority, `#…` the usual tags.
 * `@` / `!` / `截止:` are only understood inside todo lines, so e-mail addresses and normal prose are left alone.
 */
import { parseDay, parsePlan, parseTaskPlan, parseWhen } from "./date";
import type { Edit } from "../notes/edit";
import { stripTags, tagSpans } from "../notes/tags";

export const TODO_RE = /^(\s*)- \[([ xX])\] ?(.*)$/;
import { DEADLINE_WORDS, PRIORITY_WORDS_RE, deadlineToken, priorityFromWord, priorityWord } from "./words";

export interface TodoLine {
  /** Nesting level: two spaces (or one tab) per level. */
  indent: number;
  done: boolean;
  /** Everything after the checkbox. */
  text: string;
}

export function matchTodo(line: string): TodoLine | null {
  const m = TODO_RE.exec(line);
  if (!m) return null;
  const spaces = m[1].replace(/\t/g, "  ").length;
  return { indent: Math.floor(spaces / 2), done: m[2] !== " ", text: m[3] };
}

export interface TodoTokens {
  /** The text with plan / deadline / priority tokens removed (tags stay where they were). */
  rest: string;
  plan: string; // canonical raw form, "" = none
  deadline: string; // YYYY-MM-DD, "" = none
  priority: 0 | 1 | 2 | 3;
}

const DEADLINE_RE = new RegExp(String.raw`(^|\s)${DEADLINE_WORDS}[:：]\s*(\d{4}-\d{2}-\d{2})(?=\s|$)`, "i");
const PLAN_RE = /(^|\s)@(\d{4}(?:-W\d{2}|-\d{2}(?:-\d{2})?)?)(?=\s|$)/;
const PRIORITY_RE = new RegExp(String.raw`(^|\s)!(${PRIORITY_WORDS_RE})(?=\s|$)`, "i");

/** Pull the `@plan`, `截止:` and `!priority` tokens out of a todo's text. Invalid dates are left in the text untouched. */
export function splitTodoTokens(text: string): TodoTokens {
  let rest = text;
  let plan = "";
  let deadline = "";
  let priority: 0 | 1 | 2 | 3 = 0;
  const d = DEADLINE_RE.exec(rest);
  if (d && parsePlan(d[2])?.kind === "day") {
    deadline = d[2];
    rest = rest.replace(d[0], d[1]);
  }
  const p = PLAN_RE.exec(rest);
  if (p) {
    const parsed = parseTaskPlan(p[2]);
    if (parsed) {
      plan = parsed.raw;
      rest = rest.replace(p[0], p[1]);
    } else if (parsePlan(p[2])) {
      rest = rest.replace(p[0], p[1]); // a month or a year: not a todo's business any more (goals), so it is dropped
    }
  }
  const pr = PRIORITY_RE.exec(rest);
  if (pr) {
    priority = priorityFromWord(pr[2]);
    rest = rest.replace(pr[0], pr[1]);
  }
  return { rest: rest.replace(/[ \t]{2,}/g, " ").trim(), plan, deadline, priority };
}

export interface TodoMeta extends TodoTokens {
  /** The words of the todo, without tags and tokens. */
  title: string;
  /** The todo's own `#tags`. */
  tags: string[];
}

export function parseTodoText(text: string): TodoMeta {
  const t = splitTodoTokens(text);
  return { ...t, title: stripTags(t.rest).trim(), tags: [...new Set(tagSpans(t.rest).map((s) => s.tag))] };
}

export interface TodoFields {
  indent: number;
  done: boolean;
  title: string;
  tags: string[];
  plan: string;
  deadline: string;
  priority: number;
}

/** One todo line in its canonical order: title, tags, @plan, 截止, !priority. */
export function formatTodoLine(f: TodoFields): string {
  return (
    `${"  ".repeat(f.indent)}- [${f.done ? "x" : " "}] ${f.title}` +
    f.tags.map((t) => ` #${t}`).join("") +
    (f.plan ? ` @${f.plan}` : "") +
    (f.deadline ? ` ${deadlineToken()}${f.deadline}` : "") +
    (f.priority ? ` !${priorityWord(f.priority)}` : "")
  );
}


/** Every todo line of a note, with its line number. */
export function todoLinesOf(text: string): { line: number; raw: string; todo: TodoLine }[] {
  const out: { line: number; raw: string; todo: TodoLine }[] = [];
  text.split("\n").forEach((raw, line) => {
    const todo = matchTodo(raw);
    if (todo) out.push({ line, raw, todo });
  });
  return out;
}

/**
 * Typing `@下周` or `截止周五` on a todo line: the moment the word is finished (space / Enter / save) it is replaced by
 * the absolute date (`@2026-W47`, `截止:2026-11-20`), because "next week" means something else next month.
 * `caret` is right after the word. Null when the word before the caret is not a todo date word (or already absolute).
 */
export function completeTodoWords(value: string, caret: number, now = new Date()): Edit | null {
  const from = value.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = value.indexOf("\n", caret);
  if (!matchTodo(value.slice(from, lineEnd < 0 ? value.length : lineEnd))) return null;
  const before = value.slice(from, caret);
  const m = new RegExp(String.raw`(^|\s)(@|${DEADLINE_WORDS}[:：]?\s?)([^\s@:：]+)$`, "i").exec(before);
  if (!m) return null;
  let replacement: string | null = null;
  if (m[2] === "@") {
    const p = parseWhen(m[3], now);
    if (p && p.raw !== m[3]) replacement = `@${p.raw}`;
  } else {
    const day = parseDay(m[3], now);
    if (day && day !== m[3]) replacement = `${deadlineToken()}${day}`;
  }
  if (!replacement) return null;
  const start = from + before.length - (m[0].length - m[1].length);
  const out = value.slice(0, start) + replacement + value.slice(caret);
  return { value: out, start: start + replacement.length, end: start + replacement.length };
}
