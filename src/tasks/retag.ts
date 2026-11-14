import type { Task } from "../core/types";
import { isUnder } from "../notes/tags";
import { notesStore } from "../notes/store";
import { syncTasksFor } from "./sync";
import { tasksStore } from "./store";

/** `tag` after renaming `from` → `to` (children follow), or null when it was deleted along with `from`. */
export function remapTag(tag: string, from: string, to: string | null): string | null {
  if (!isUnder(tag, from)) return tag;
  return to === null ? null : `${to}${tag.slice(from.length)}`;
}
const remapAll = (tags: string[], from: string, to: string | null) => [...new Set(tags.map((t) => remapTag(t, from, to)).filter((t): t is string => !!t))];

/**
 * A tag was renamed or deleted (the notes were already rewritten): make the task library follow.
 * Todos on the 任务 page change their own tags; todos written in notes are re-read from the rewritten notes.
 */
export async function retagTasks(from: string, to: string | null) {
  const all = await tasksStore.all();
  const now = Date.now();
  const put: Task[] = [];
  for (const t of all) {
    if (t.sourceNoteId) continue;
    const own = remapAll(t.ownTags, from, to);
    const tags = remapAll(t.tags, from, to);
    if (own.join("\u0000") !== t.ownTags.join("\u0000") || tags.join("\u0000") !== t.tags.join("\u0000")) put.push({ ...t, ownTags: own, tags, updatedAt: now });
  }
  if (put.length) await tasksStore.apply(put);
  const hasTasks = new Set(all.filter((t) => t.sourceNoteId).map((t) => t.sourceNoteId as string));
  const notes = (await notesStore.query({ sort: "time", limit: -1 })).items.map((h) => h.note).filter((n) => hasTasks.has(n.id) || /- \[[ xX]\]/.test(n.note));
  if (notes.length) await syncTasksFor(notes);
}
