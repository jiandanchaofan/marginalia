/**
 * Task library. Desktop: SQLite via Rust commands. Plain browser (`npm run dev`): localStorage with the same rules
 * (deleting a task deletes its subtasks). The list is cached in memory; everything that changes tasks goes through `apply`.
 */
import type { Task } from "../core/types";
import { isTauri } from "../platform";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const LS_TASKS = "reader:tasks";
const browserTasks = (): Task[] => {
  try {
    return JSON.parse(localStorage.getItem(LS_TASKS) ?? "[]");
  } catch {
    return [];
  }
};
const saveBrowser = (list: Task[]) => {
  try {
    localStorage.setItem(LS_TASKS, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
};

export const newTaskId = () => (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Apply puts and deletes to a list the way the database does: upsert by id, deleting a task deletes its subtasks. */
export function applyToList(list: Task[], put: Task[], del: string[]): Task[] {
  const map = new Map(list.map((t) => [t.id, t]));
  for (const t of put) map.set(t.id, t);
  const gone = new Set(del);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of map.values()) if (!gone.has(t.id) && t.parentId && gone.has(t.parentId)) (gone.add(t.id), (grew = true));
  }
  return [...map.values()].filter((t) => !gone.has(t.id)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

let cache: Task[] | null = null;
const listeners = new Set<() => void>();
export let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Months and years are for goals now: clear them from tasks that were planned that way before (once, quietly). */
async function dropYearMonthPlans() {
  const old = (cache ?? []).filter((t) => t.planKind === "month" || t.planKind === "year");
  if (!old.length) return;
  const fixed = old.map((t) => ({ ...t, plan: "", planKind: "" as const, planStart: "", planEnd: "" }));
  if (isTauri) await invoke("tasks_apply", { put: fixed, delete: [] });
  cache = applyToList(cache ?? [], fixed, []);
  if (!isTauri) saveBrowser(cache);
}

export const tasksStore = {
  async all(): Promise<Task[]> {
    if (!cache) {
      cache = isTauri ? await invoke<Task[]>("tasks_all") : browserTasks();
      await dropYearMonthPlans();
    }
    return cache;
  },

  /** Write and delete in one go (all or nothing on the desktop). Rejects when the database refuses. */
  async apply(put: Task[], del: string[] = []) {
    if (!put.length && !del.length) return;
    const before = await this.all();
    if (isTauri) await invoke("tasks_apply", { put, delete: del });
    const next = applyToList(before, put, del);
    if (!isTauri) saveBrowser(next);
    cache = next;
    changed();
  },

  /** Forget the cache and tell everybody to re-read (after notes were deleted: their tasks went with them). */
  refresh() {
    cache = null;
    changed();
  },

  /** Browser only: the notes are gone, so are their tasks (the database does this with a cascade). */
  dropByNotes(noteIds: string[]) {
    if (isTauri || !noteIds.length) return this.refresh();
    const gone = new Set(noteIds);
    const list = browserTasks();
    const doomed = list.filter((t) => t.sourceNoteId && gone.has(t.sourceNoteId)).map((t) => t.id);
    saveBrowser(applyToList(list, [], doomed));
    this.refresh();
  },

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
