/**
 * Turning a module's plan (a list of planned to-dos) into real to-dos and goals, and looking after them afterwards.
 * The to-dos go into the task library like any other (one for each day); the plan also gets a goal for each month it
 * covers (under a goal for the year) so its progress shows where goals are shown.
 */
import type { Task } from "../core/types";
import { createTasks } from "../tasks/actions";
import { createGoal, linkTasks } from "../tasks/goalActions";
import { goalStore } from "../tasks/goalStore";
import { tasksStore } from "../tasks/store";
import type { PlannedTask } from "./sdk";

export interface PlanIds {
  taskIds: string[];
  goalIds: string[];
}

export async function applyPlan(title: string, planned: PlannedTask[]): Promise<PlanIds> {
  if (!planned.length) return { taskIds: [], goalIds: [] };
  const tasks = await createTasks(planned.map((p) => ({ title: p.title, tags: p.tags, plan: p.day })));
  const goalIds: string[] = [];
  const years = new Map<string, string>();
  const byMonth = new Map<string, string[]>();
  planned.forEach((p, i) => {
    const m = p.day.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), tasks[i].id]);
  });
  for (const [month, ids] of byMonth) {
    const year = month.slice(0, 4);
    if (!years.has(year)) {
      const yg = await createGoal({ title, kind: "year", period: year });
      years.set(year, yg.id);
      goalIds.push(yg.id);
    }
    const mg = await createGoal({ title, kind: "month", period: month, parentId: years.get(year), mode: "auto" });
    goalIds.push(mg.id);
    await linkTasks(mg.id, ids);
  }
  return { taskIds: tasks.map((t) => t.id), goalIds };
}

/** Take a plan back: its to-dos and the goals made for it. */
export async function removePlan(ids: PlanIds): Promise<void> {
  await tasksStore.apply([], ids.taskIds);
  await goalStore.apply({ delete: ids.goalIds });
}

export interface PlanProgress {
  done: number;
  total: number;
  /** The first day not yet done. */
  next?: { title: string; day: string };
}

export async function planProgress(taskIds: string[]): Promise<PlanProgress> {
  const mine = new Set(taskIds);
  const tasks = (await tasksStore.all()).filter((t: Task) => mine.has(t.id));
  const open = tasks.filter((t) => !t.done).sort((a, b) => a.planStart.localeCompare(b.planStart));
  return { done: tasks.length - open.length, total: tasks.length, next: open[0] ? { title: open[0].title, day: open[0].planStart } : undefined };
}

export const onTasksChanged = (cb: () => void): (() => void) => tasksStore.subscribe(cb);
