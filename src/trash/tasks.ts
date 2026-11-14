import type { Task } from "../core/types";
import { notesStore } from "../notes/store";
import { tasksStore } from "../tasks/store";
import { goalStore } from "../tasks/goalStore";
import { locateTodoLine, removeTodoLine } from "../tasks/writeback";
import { trashStore, type TrashEntry } from "./store";

/** A to-do thrown away with its subtasks and what hung on it. */
export interface TaskPayload {
  /** The task first, then everything below it. */
  tasks: Task[];
  /** [task id, goal id] of those tasks. */
  goalLinks: [string, string][];
  /** For a to-do that came from a note: the lines taken out of the note, and where they were. */
  fromNote?: { noteId: string; at: number; lines: string[] };
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function subtree(all: Task[], root: Task): Task[] {
  const out = [root];
  const have = new Set([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) if (t.parentId && have.has(t.parentId) && !have.has(t.id)) (out.push(t), have.add(t.id), (grew = true));
  }
  return out;
}

/** Put a to-do (and its subtasks) into the recycle bin. Call before deleting it. Returns the entry ids. */
export async function trashTask(task: Task): Promise<string[]> {
  const [all, goals] = await Promise.all([tasksStore.all(), goalStore.all()]);
  const tasks = subtree(all, task);
  const ids = new Set(tasks.map((t) => t.id));
  const payload: TaskPayload = { tasks, goalLinks: goals.links.filter(([t]) => ids.has(t)) };
  if (task.sourceNoteId) {
    const hit = (await notesStore.byIds([task.sourceNoteId]))[0];
    const before = hit?.note.note ?? "";
    const after = hit ? removeTodoLine(before, task) : null;
    const at = hit ? locateTodoLine(before, task) : -1;
    if (hit && after !== null && at >= 0) {
      const old = before.split("\n");
      payload.fromNote = { noteId: hit.note.id, at, lines: old.slice(at, at + (old.length - after.split("\n").length)) };
    }
  }
  const entry: TrashEntry<TaskPayload> = { id: uid(), kind: "task", deletedAt: Date.now(), title: task.title, payload };
  await trashStore.put([entry]);
  return [entry.id];
}

/** Take to-dos back out of the bin. Returns how many came back. */
export async function restoreTasks(ids: string[]): Promise<number> {
  const all = await trashStore.all();
  let n = 0;
  for (const e of all.filter((x) => ids.includes(x.id) && x.kind === "task")) {
    const p = e.payload as TaskPayload | null;
    if (!p?.tasks?.length) {
      await trashStore.remove([e.id]);
      continue;
    }
    const existing = await tasksStore.all();
    const have = new Set(existing.map((t) => t.id));
    const ids_ = new Set(p.tasks.map((t) => t.id));
    const noteOk = p.fromNote ? (await notesStore.byIds([p.fromNote.noteId])).length > 0 : true;
    const tasks = p.tasks.map((t, i) => (i === 0 && t.parentId && !have.has(t.parentId) && !ids_.has(t.parentId) ? { ...t, parentId: null } : t)); // its parent is gone: it stands on its own
    // the note it came from is gone: it becomes an ordinary to-do
    const sources = [...new Set(tasks.map((t) => t.sourceNoteId).filter((x): x is string => !!x))];
    const alive = new Set((await notesStore.byIds(sources)).map((h) => h.note.id));
    const fixed = tasks.map((t) => (t.sourceNoteId && !alive.has(t.sourceNoteId) ? { ...t, sourceNoteId: null, sourceLine: "" } : t));
    await tasksStore.apply(fixed);
    const goals = new Set((await goalStore.all()).goals.map((g) => g.id));
    const link = p.goalLinks.filter(([, g]) => goals.has(g));
    if (link.length) await goalStore.apply({ link }).catch(() => {});
    // put the lines back into the note (its tasks are already there, so the note's sync keeps them as they are)
    if (p.fromNote && noteOk) {
      const hit = (await notesStore.byIds([p.fromNote.noteId]))[0];
      if (hit) {
        const lines = hit.note.note.split("\n");
        lines.splice(Math.min(p.fromNote.at, lines.length), 0, ...p.fromNote.lines);
        await notesStore.update(hit.bookId, { ...hit.note, note: lines.join("\n"), updatedAt: Date.now() });
      }
    }
    await trashStore.remove([e.id]);
    n++;
  }
  return n;
}
