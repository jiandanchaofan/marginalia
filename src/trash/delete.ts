import { notesStore, type NoteHit } from "../notes/store";
import { t } from "../i18n";
import { restoreNotes } from "./notes";
import { restoreTasks, trashTask } from "./tasks";
import { deleteTask } from "../tasks/actions";
import type { Task } from "../core/types";
import { confirmTrash, toast } from "./ui";
import { trashStore } from "./store";

const undoNotes = (ids: string[]) => async () => {
  const n = await restoreNotes(ids);
  if (n) toast(t("tr.restored", { n }));
};

/** Move notes to the recycle bin: ask first (unless turned off), then say so lightly, with an undo. */
export async function deleteNotes(hits: NoteHit[]): Promise<boolean> {
  if (!hits.length) return false;
  const message = hits.length === 1 ? t("tr.confirmNote") : t("tr.confirmNotes", { n: hits.length });
  if (!(await confirmTrash(message))) return false;
  const ids = await notesStore.removeMany(hits);
  toast(hits.length === 1 ? t("tr.movedNote") : t("tr.movedNotes", { n: hits.length }), ids.length ? { undo: undoNotes(ids) } : {});
  return true;
}

/** A note on its own was removed somewhere else (the reader keeps its notes in memory): ask, and report afterwards. */
export async function askDeleteNote(text: string): Promise<boolean> {
  return !text.trim() || confirmTrash(t("tr.confirmNote"));
}
export const reportDeleted = () => toast(t("tr.movedNote"));


const undoTasks = (ids: string[]) => async () => {
  const n = await restoreTasks(ids);
  if (n) toast(t("tr.restoredTask"));
};

/** Move a to-do (with its subtasks) to the recycle bin. Returns an error message, or null when it went (or the user said no). */
export async function deleteTaskToBin(task: Task, below: number): Promise<string | null> {
  const part = below ? (task.sourceNoteId ? t("tasks.belowItems", { n: below }) : t("tasks.withSubtasks", { n: below })) : "";
  const message = task.sourceNoteId ? t("tr.confirmTaskNote", { below: part }) : t("tr.confirmTask", { title: task.title, below: part });
  if (!(await confirmTrash(message))) return null;
  const ids = await trashTask(task);
  const err = await deleteTask(task);
  if (err) {
    await trashStore.remove(ids); // nothing was deleted after all
    return err;
  }
  toast(t("tr.movedTask"), { undo: undoTasks(ids) });
  return null;
}
