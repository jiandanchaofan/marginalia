/**
 * Everything the task page does to a task. A task that came from a note is changed by rewriting its line in the note
 * (saving the note brings the task up to date); a standalone task is changed in the task library directly.
 */
import type { Task } from "../core/types";
import { notesStore } from "../notes/store";
import { parseTaskPlan, type Plan } from "./date";
import { editTodoLine, insertChildLine, removeTodoLine, type TodoPatch } from "./writeback";
import { newTaskId, tasksStore } from "./store";
import { t as tr } from "../i18n";

export interface Fields {
  title?: string;
  done?: boolean;
  /** Written form of the plan (`2026-W47`), "" = not planned. */
  plan?: string;
  deadline?: string;
  priority?: number;
  /** Own tags (without `#`). */
  tags?: string[];
  /** Remarks: stored in the task library only. */
  note?: string;
}

const planFields = (raw: string) => {
  const p = raw ? parseTaskPlan(raw) : null;
  return { plan: p?.raw ?? "", planKind: (p?.kind ?? "") as Task["planKind"], planStart: p?.start ?? "", planEnd: p?.end ?? "" };
};

/** A new standalone task (made on the task page). */
export async function createTask(f: { title: string; tags?: string[]; plan?: Plan | null; deadline?: string; priority?: number; parentId?: string | null }): Promise<Task> {
  const now = Date.now();
  const tags = [...new Set(f.tags ?? [])];
  const t: Task = {
    id: newTaskId(),
    title: f.title.trim(),
    note: "",
    done: false,
    doneAt: null,
    priority: f.priority ?? 0,
    ...planFields(f.plan?.raw ?? ""),
    deadline: f.deadline ?? "",
    tags,
    ownTags: tags,
    parentId: f.parentId ?? null,
    sort: now,
    sourceNoteId: null,
    sourceLine: "",
    createdAt: now,
    updatedAt: now,
  };
  await tasksStore.apply([t]);
  return t;
}

async function sourceNote(t: Task) {
  const hit = t.sourceNoteId ? (await notesStore.byIds([t.sourceNoteId]))[0] : undefined;
  return hit;
}

/** Change a task. Returns an error message when the note it came from can no longer be found / written. */
export async function updateTask(t: Task, f: Fields): Promise<string | null> {
  const now = Date.now();
  // remarks live in the task library for every kind of task
  const remarkOnly = Object.keys(f).every((k) => k === "note");
  if (!t.sourceNoteId || remarkOnly) {
    const next: Task = { ...t, updatedAt: now };
    if (f.note !== undefined) next.note = f.note;
    if (!remarkOnly) {
      if (f.title !== undefined) next.title = f.title.trim();
      if (f.done !== undefined) {
        next.done = f.done;
        next.doneAt = f.done ? (t.done ? t.doneAt ?? now : now) : null;
      }
      if (f.plan !== undefined) Object.assign(next, planFields(f.plan));
      if (f.deadline !== undefined) next.deadline = f.deadline;
      if (f.priority !== undefined) next.priority = f.priority;
      if (f.tags !== undefined) {
        const inherited = t.tags.filter((x) => !t.ownTags.includes(x));
        next.ownTags = [...new Set(f.tags)];
        next.tags = [...new Set([...next.ownTags, ...inherited])];
      }
    }
    await tasksStore.apply([next]);
    return null;
  }
  const hit = await sourceNote(t);
  if (!hit) return tr("act.noSource");
  const patch: TodoPatch = { title: f.title, done: f.done, plan: f.plan, deadline: f.deadline, priority: f.priority, tags: f.tags };
  const text = editTodoLine(hit.note.note, t, patch);
  if (text === null) return tr("act.noLine");
  await notesStore.update(hit.bookId, { ...hit.note, note: text, updatedAt: now });
  if (f.note !== undefined) await tasksStore.apply([{ ...t, note: f.note, updatedAt: now }]);
  return null;
}

/** Delete a task (and everything below it). For a task from a note this removes its line (and the lines nested under it) from the note. */
export async function deleteTask(t: Task): Promise<string | null> {
  if (!t.sourceNoteId) {
    await tasksStore.apply([], [t.id]);
    return null;
  }
  const hit = await sourceNote(t);
  if (!hit) {
    await tasksStore.apply([], [t.id]);
    return null;
  }
  const text = removeTodoLine(hit.note.note, t);
  if (text === null) return tr("act.noLine");
  await notesStore.update(hit.bookId, { ...hit.note, note: text, updatedAt: Date.now() });
  return null;
}

/** Add a subtask under `parent`. For a parent that came from a note the new line goes into the note. */
export async function addSubtask(parent: Task, title: string): Promise<string | null> {
  const name = title.trim();
  if (!name) return null;
  if (!parent.sourceNoteId) {
    await createTask({ title: name, parentId: parent.id, tags: [] });
    return null;
  }
  const hit = await sourceNote(parent);
  if (!hit) return tr("act.noSource");
  const text = insertChildLine(hit.note.note, parent, name);
  if (text === null) return tr("act.noLine");
  await notesStore.update(hit.bookId, { ...hit.note, note: text, updatedAt: Date.now() });
  return null;
}
