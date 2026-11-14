/**
 * Changes made to a task that came from a note are written into that note's todo line (the note stays the single
 * source of truth); saving the note then brings the task up to date again.
 */
import type { Task } from "../core/types";
import { formatTodoLine, matchTodo, parseTodoText } from "./parse";

/** Which line of the note holds this task: the one that still reads exactly as last seen (nearest to where it was), else the one with the same words. */
export function locateTodoLine(noteText: string, task: Pick<Task, "sourceLine" | "title" | "sort">): number {
  const lines = noteText.split("\n");
  const nearest = (hits: number[]) => hits.sort((a, b) => Math.abs(a - task.sort) - Math.abs(b - task.sort))[0] ?? -1;
  const exact = nearest(lines.flatMap((l, i) => (l === task.sourceLine ? [i] : [])));
  if (exact >= 0) return exact;
  return nearest(lines.flatMap((l, i) => (matchTodo(l) && parseTodoText(matchTodo(l)!.text).title === task.title ? [i] : [])));
}

export interface TodoPatch {
  title?: string;
  done?: boolean;
  /** Own tags (without `#`). */
  tags?: string[];
  plan?: string;
  deadline?: string;
  priority?: number;
}

/** The note text with this task's line rewritten (canonical order: title, tags, @plan, 截止, !priority). Null when the line cannot be found. */
export function editTodoLine(noteText: string, task: Pick<Task, "sourceLine" | "title" | "sort">, patch: TodoPatch): string | null {
  const i = locateTodoLine(noteText, task);
  if (i < 0) return null;
  const lines = noteText.split("\n");
  const cur = matchTodo(lines[i])!;
  const meta = parseTodoText(cur.text);
  lines[i] = formatTodoLine({
    indent: cur.indent,
    done: patch.done ?? cur.done,
    title: patch.title ?? meta.title,
    tags: patch.tags ?? meta.tags,
    plan: patch.plan ?? meta.plan,
    deadline: patch.deadline ?? meta.deadline,
    priority: patch.priority ?? meta.priority,
  });
  return lines.join("\n");
}

/** The note text without this task's line and the lines nested under it. Null when the line cannot be found. */
export function removeTodoLine(noteText: string, task: Pick<Task, "sourceLine" | "title" | "sort">): string | null {
  const i = locateTodoLine(noteText, task);
  if (i < 0) return null;
  const lines = noteText.split("\n");
  const indent = matchTodo(lines[i])!.indent;
  let end = i + 1;
  while (end < lines.length) {
    const t = matchTodo(lines[end]);
    if (!t || t.indent <= indent) break;
    end++;
  }
  lines.splice(i, end - i);
  return lines.join("\n");
}

/** The note text with a new subtask line added at the end of this task's subtree. Null when the task's line cannot be found. */
export function insertChildLine(noteText: string, parent: Pick<Task, "sourceLine" | "title" | "sort">, title: string): string | null {
  const i = locateTodoLine(noteText, parent);
  if (i < 0) return null;
  const lines = noteText.split("\n");
  const indent = matchTodo(lines[i])!.indent;
  let end = i + 1;
  while (end < lines.length) {
    const t = matchTodo(lines[end]);
    if (!t || t.indent <= indent) break;
    end++;
  }
  lines.splice(end, 0, formatTodoLine({ indent: indent + 1, done: false, title, tags: [], plan: "", deadline: "", priority: 0 }));
  return lines.join("\n");
}
