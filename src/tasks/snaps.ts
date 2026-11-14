/**
 * Goal progress snapshots: how far each goal was on a given day. Goals do not keep a history of their progress, so the
 * app writes one snapshot per goal and day (the latest of the day wins); the weekly review compares today with the
 * last snapshot before the week began. Desktop: SQLite. Plain browser: localStorage.
 */
import { isTauri } from "../platform";
import { goalStore } from "./goalStore";
import { progressOfGoal, supportMap } from "./goals";
import { tasksStore } from "./store";
import { todayStr } from "./date";

export interface Snap {
  day: string;
  goalId: string;
  percent: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const KEY = "reader:goal-snaps";
const readBrowser = (): Snap[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export const snapStore = {
  async all(): Promise<Snap[]> {
    return isTauri ? invoke<Snap[]>("goal_snaps_all") : readBrowser();
  },
  async save(day: string, items: [string, number][]) {
    if (!items.length) return;
    if (isTauri) return invoke("goal_snaps_save", { day, items });
    const rows = readBrowser().filter((r) => !(r.day === day && items.some(([id]) => id === r.goalId)));
    for (const [goalId, percent] of items) rows.push({ day, goalId, percent });
    try {
      localStorage.setItem(KEY, JSON.stringify(rows));
    } catch {
      /* storage unavailable */
    }
  },
};

/** Write today's snapshot of every goal. */
export async function recordGoalSnaps() {
  const { goals, links } = await goalStore.all();
  const support = supportMap(links, await tasksStore.all());
  await snapStore.save(
    todayStr(),
    goals.map((g): [string, number] => [g.id, progressOfGoal(g, support).percent]),
  );
}

/** The percent a goal stood at on the last snapshot taken before `day` (null when there is none). */
export function percentBefore(snaps: Snap[], goalId: string, day: string): number | null {
  let best: Snap | null = null;
  for (const s of snaps) if (s.goalId === goalId && s.day < day && (!best || s.day > best.day)) best = s;
  return best ? best.percent : null;
}
