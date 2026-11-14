/**
 * Goals and the links between todos and goals. Desktop: SQLite via Rust commands. Plain browser: localStorage with
 * the same rules (deleting a goal removes its links and un-parents its month goals). Cached in memory.
 */
import type { Goal } from "../core/types";
import { isTauri } from "../platform";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export type Link = [taskId: string, goalId: string];
export interface GoalData {
  goals: Goal[];
  links: Link[];
}
export interface GoalChange {
  put?: Goal[];
  delete?: string[];
  link?: Link[];
  unlink?: Link[];
}

const LS = "reader:goals";
const readBrowser = (): GoalData => {
  try {
    const d = JSON.parse(localStorage.getItem(LS) ?? "null");
    return d && Array.isArray(d.goals) ? { goals: d.goals, links: d.links ?? [] } : { goals: [], links: [] };
  } catch {
    return { goals: [], links: [] };
  }
};
const saveBrowser = (d: GoalData) => {
  try {
    localStorage.setItem(LS, JSON.stringify(d));
  } catch {
    /* storage unavailable */
  }
};

export const newGoalId = () => (crypto.randomUUID ? crypto.randomUUID() : `g${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Apply a change the way the database does. */
export function applyGoalChange(d: GoalData, c: GoalChange): GoalData {
  const map = new Map(d.goals.map((g) => [g.id, g]));
  for (const g of c.put ?? []) map.set(g.id, g);
  const gone = new Set(c.delete ?? []);
  for (const id of gone) map.delete(id);
  const goals = [...map.values()].map((g) => (g.parentId && gone.has(g.parentId) ? { ...g, parentId: null } : g)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const key = (l: Link) => `${l[0]}\u0000${l[1]}`;
  const links = new Map(d.links.filter((l) => !gone.has(l[1])).map((l) => [key(l), l]));
  for (const l of c.link ?? []) links.set(key(l), l);
  for (const l of c.unlink ?? []) links.delete(key(l));
  return { goals, links: [...links.values()] };
}

let cache: GoalData | null = null;
const listeners = new Set<() => void>();
export let goalVersion = 0;
const changed = () => {
  goalVersion++;
  listeners.forEach((l) => l());
};

let queue: Promise<unknown> = Promise.resolve();

export const goalStore = {
  async all(): Promise<GoalData> {
    if (!cache) cache = isTauri ? await invoke<GoalData>("goals_all") : readBrowser();
    return cache;
  },
  /** One change at a time, so quick successive clicks never overwrite each other. */
  apply(c: GoalChange): Promise<void> {
    const run = queue.then(() => this.applyNow(c));
    queue = run.catch(() => undefined);
    return run;
  },
  async applyNow(c: GoalChange) {
    if (!(c.put?.length || c.delete?.length || c.link?.length || c.unlink?.length)) return;
    const before = await this.all();
    if (isTauri) await invoke("goals_apply", { put: c.put ?? [], delete: c.delete ?? [], link: c.link ?? [], unlink: c.unlink ?? [] });
    const next = applyGoalChange(before, c);
    if (!isTauri) saveBrowser(next);
    cache = next;
    changed();
  },
  /** Forget the cache (tasks went away with their notes, taking their links along). */
  refresh() {
    cache = null;
    changed();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
