/**
 * Todo lines of a note → tasks. The note's text is the source of truth for the title, done state, plan, deadline,
 * priority and nesting of a task that came from it; the task library keeps what the text cannot (remarks, completion time).
 */
import type { Annotation, Task } from "../core/types";
import { parseTaskPlan } from "./date";
import { matchTodo, parseTodoText, todoLinesOf } from "./parse";
import { parseTags } from "../notes/tags";
import { newTaskId, tasksStore } from "./store";

const FIELDS: (keyof Task)[] = ["title", "note", "done", "doneAt", "priority", "plan", "planKind", "planStart", "planEnd", "deadline", "parentId", "sort", "sourceNoteId", "sourceLine"];
export const sameTask = (a: Task, b: Task) => FIELDS.every((k) => a[k] === b[k]) && a.tags.join("\u001f") === b.tags.join("\u001f") && a.ownTags.join("\u001f") === b.ownTags.join("\u001f");

/** Tags written outside the todo lines: what every todo of the note inherits. */
export const noteLevelTags = (text: string) =>
  parseTags(
    text
      .split("\n")
      .filter((l) => !matchTodo(l))
      .join("\n"),
  );

/**
 * What to write and delete so that the tasks of `note` match its todo lines.
 * Lines are matched to existing tasks first by identical title, then (for lines whose words were edited) in order —
 * so editing a todo keeps its task (and its remarks) instead of replacing it.
 */
export function syncNoteTasks(note: Annotation, existing: Task[], now: number): { put: Task[]; del: string[] } {
  const items = todoLinesOf(note.note)
    .map(({ line, raw, todo }) => ({ line, raw, indent: todo.indent, done: todo.done, meta: parseTodoText(todo.text) }))
    .filter((i) => i.meta.title); // a todo with no words yet ("- [ ]" just typed) is not a task
  const free = existing.filter((t) => t.sourceNoteId === note.id).sort((a, b) => a.sort - b.sort);
  const match = new Map<number, Task>();
  items.forEach((it, i) => {
    const k = free.findIndex((t) => t.title === it.meta.title);
    if (k >= 0) match.set(i, free.splice(k, 1)[0]);
  });
  items.forEach((_, i) => {
    if (!match.has(i) && free.length) match.set(i, free.shift()!);
  });

  const inherited = noteLevelTags(note.note);
  const put: Task[] = [];
  const stack: { indent: number; id: string }[] = [];
  items.forEach((it, i) => {
    const old = match.get(i);
    const id = old?.id ?? newTaskId();
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : null;
    stack.push({ indent: it.indent, id });
    const plan = it.meta.plan ? parseTaskPlan(it.meta.plan) : null;
    const task: Task = {
      id,
      title: it.meta.title,
      note: old?.note ?? "",
      done: it.done,
      doneAt: it.done ? (old?.done ? (old.doneAt ?? now) : now) : null,
      priority: it.meta.priority,
      plan: plan?.raw ?? "",
      planKind: plan?.kind ?? "",
      planStart: plan?.start ?? "",
      planEnd: plan?.end ?? "",
      deadline: it.meta.deadline,
      tags: [...new Set([...it.meta.tags, ...inherited])],
      ownTags: it.meta.tags,
      parentId,
      sort: it.line,
      sourceNoteId: note.id,
      sourceLine: it.raw,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    if (!old || !sameTask(old, task)) put.push(task);
  });
  return { put, del: free.map((t) => t.id) };
}

let queue: Promise<void> = Promise.resolve();

/** Bring the tasks of these notes up to date (called after notes are saved). Runs one at a time, in order. */
export function syncTasksFor(notes: Annotation[]): Promise<void> {
  queue = queue
    .then(async () => {
      const all = await tasksStore.all();
      const byNote = new Map<string, Task[]>();
      for (const t of all) if (t.sourceNoteId) byNote.set(t.sourceNoteId, [...(byNote.get(t.sourceNoteId) ?? []), t]);
      const put: Task[] = [];
      const del: string[] = [];
      const now = Date.now();
      for (const n of notes) {
        const mine = byNote.get(n.id);
        if (!mine && !/- \[[ xX]\]/.test(n.note)) continue; // nothing to do for a note with no todos and no tasks
        const r = syncNoteTasks(n, mine ?? [], now);
        put.push(...r.put);
        del.push(...r.del);
      }
      if (put.length || del.length) await tasksStore.apply(put, del);
    })
    .catch((e) => console.warn("task sync failed", e));
  return queue;
}
