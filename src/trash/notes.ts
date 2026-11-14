import type { Annotation, Task } from "../core/types";
import { notesStore, setRemovalHook, type NoteHit } from "../notes/store";
import { notePreview } from "../notes/links";
import { tasksStore } from "../tasks/store";
import { goalStore } from "../tasks/goalStore";
import { reviewStore } from "../review/store";
import type { ReviewItem } from "../review/schedule";
import { trashStore, type TrashEntry } from "./store";

type NoteLink = Awaited<ReturnType<typeof notesStore.links>>[number];

/** Everything that hangs on a note and goes with it when it is deleted. */
export interface NotePayload {
  bookId: string;
  note: Annotation;
  links: NoteLink[];
  review: ReviewItem | null;
  /** To-dos that came from this note's todo lines (and their subtasks). */
  tasks: Task[];
  /** [task id, goal id] of those to-dos. */
  goalLinks: [string, string][];
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** The to-dos derived from a note, with every subtask below them. */
function derivedTasks(all: Task[], noteId: string): Task[] {
  const out = all.filter((t) => t.sourceNoteId === noteId);
  const have = new Set(out.map((t) => t.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) if (t.parentId && have.has(t.parentId) && !have.has(t.id)) (out.push(t), have.add(t.id), (grew = true));
  }
  return out;
}

/** Put notes into the recycle bin (call before they are deleted: the snapshot reads what is still there). Returns the entry ids. */
export async function trashNotes(hits: NoteHit[]): Promise<string[]> {
  if (!hits.length) return [];
  const [links, tasks, goals, review] = await Promise.all([notesStore.links(), tasksStore.all(), goalStore.all(), reviewStore.all()]);
  const now = Date.now();
  const entries: TrashEntry<NotePayload>[] = hits.map((h, i) => {
    const mine = derivedTasks(tasks, h.note.id);
    const ids = new Set(mine.map((t) => t.id));
    return {
      id: uid(),
      kind: "note",
      deletedAt: now + i, // keeps a batch in its original order
      title: notePreview(h.note, 120),
      payload: {
        bookId: h.bookId,
        note: h.note,
        links: links.filter((l) => l.a === h.note.id || l.b === h.note.id),
        review: review.items.find((r) => r.noteId === h.note.id) ?? null,
        tasks: mine,
        goalLinks: goals.links.filter(([t]) => ids.has(t)),
      },
    };
  });
  await trashStore.put(entries);
  return entries.map((e) => e.id);
}

/** Take notes back out of the bin and write everything that hung on them back. */
export async function restoreNotes(ids: string[]): Promise<number> {
  const all = await trashStore.all();
  let n = 0;
  for (const e of all.filter((x) => ids.includes(x.id) && x.kind === "note")) {
    const p = e.payload as NotePayload | null;
    if (!p?.note) {
      await trashStore.remove([e.id]);
      continue;
    }
    await notesStore.add(p.bookId, p.note, { noSync: true });
    // links whose other end is still there
    const others = [...new Set(p.links.map((l) => (l.a === p.note.id ? l.b : l.a)))];
    const alive = new Set((await notesStore.byIds(others)).map((h) => h.note.id));
    const links = p.links.filter((l) => alive.has(l.a === p.note.id ? l.b : l.a));
    if (links.length) await notesStore.putLinks(links).catch(() => {});
    if (p.review) await reviewStore.put([p.review]);
    if (p.tasks.length) {
      await tasksStore.apply(p.tasks);
      const goals = new Set((await goalStore.all()).goals.map((g) => g.id));
      const link = p.goalLinks.filter(([, g]) => goals.has(g));
      if (link.length) await goalStore.apply({ link }).catch(() => {});
    }
    await trashStore.remove([e.id]);
    n++;
  }
  return n;
}

// every way of deleting a note goes through notesStore, which hands the notes over here first
setRemovalHook(trashNotes);
