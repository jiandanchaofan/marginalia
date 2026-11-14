import { isTauri } from "../platform";
import { notesChanged, subscribeNotes } from "../notes/store";
import { tasksStore } from "../tasks/store";
import { goalStore } from "../tasks/goalStore";
import { reviewStore } from "../review/store";

const EVENT = "reader:data-changed";
let remote = false;

/**
 * The main window and the desktop cards are separate windows with their own copies of the data. Whenever one of them
 * changes notes, tasks or goals it tells the others, which re-read (a change that arrives from outside is not sent on again).
 */
export async function startSync(): Promise<() => void> {
  if (!isTauri) return () => {};
  const { emit, listen } = await import("@tauri-apps/api/event");
  const me = Math.random().toString(36).slice(2);
  const send = (what: string) => {
    if (!remote) void emit(EVENT, { from: me, what });
  };
  const offs = [subscribeNotes(() => send("notes")), tasksStore.subscribe(() => send("tasks")), goalStore.subscribe(() => send("goals")), reviewStore.subscribe(() => send("review"))];
  const un = await listen<{ from: string; what: string }>(EVENT, (e) => {
    if (e.payload.from === me) return;
    remote = true;
    try {
      if (e.payload.what === "notes") notesChanged();
      else if (e.payload.what === "tasks") tasksStore.refresh();
      else if (e.payload.what === "goals") goalStore.refresh();
      else if (e.payload.what === "review") reviewStore.refresh();
    } finally {
      remote = false;
    }
  });
  return () => {
    offs.forEach((f) => f());
    un();
  };
}
