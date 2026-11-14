import type { Goal } from "../core/types";
import { goalStore, newGoalId, type Link } from "./goalStore";

export interface GoalFields {
  title?: string;
  note?: string;
  kind?: Goal["kind"];
  period?: string;
  parentId?: string | null;
  status?: Goal["status"];
  mode?: Goal["mode"];
  percent?: number;
}

export async function createGoal(f: { title: string; kind: Goal["kind"]; period: string; parentId?: string | null; mode?: Goal["mode"]; percent?: number; note?: string }): Promise<Goal> {
  const now = Date.now();
  const g: Goal = {
    id: newGoalId(),
    title: f.title.trim(),
    note: f.note ?? "",
    kind: f.kind,
    period: f.period,
    parentId: f.kind === "month" ? f.parentId ?? null : null,
    status: "doing",
    mode: f.kind === "year" ? "manual" : f.mode ?? "auto",
    percent: Math.max(0, Math.min(100, Math.round(f.percent ?? 0))),
    sort: now,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await goalStore.apply({ put: [g] });
  return g;
}

export async function updateGoal(g: Goal, f: GoalFields): Promise<Goal> {
  const kind = f.kind ?? g.kind;
  const status = f.status ?? g.status;
  const next: Goal = {
    ...g,
    ...f,
    kind,
    title: (f.title ?? g.title).trim() || g.title,
    percent: Math.max(0, Math.min(100, Math.round(f.percent ?? g.percent))),
    parentId: kind === "month" ? (f.parentId === undefined ? g.parentId : f.parentId) : null,
    mode: kind === "year" ? "manual" : f.mode ?? g.mode,
    closedAt: status === "doing" ? null : status !== g.status ? Date.now() : g.closedAt,
    updatedAt: Date.now(),
  };
  await goalStore.apply({ put: [next] });
  return next;
}

export const deleteGoal = (g: Goal) => goalStore.apply({ delete: [g.id] });

/** Make `taskIds` support `goalId` / stop supporting it. */
export const linkTasks = (goalId: string, taskIds: string[]) => goalStore.apply({ link: taskIds.map((t): Link => [t, goalId]) });
export const unlinkTasks = (goalId: string, taskIds: string[]) => goalStore.apply({ unlink: taskIds.map((t): Link => [t, goalId]) });

/** Set the exact list of goals one task supports. */
export async function setTaskGoals(taskId: string, goalIds: string[], current: string[]) {
  const want = new Set(goalIds);
  const have = new Set(current);
  await goalStore.apply({
    link: goalIds.filter((g) => !have.has(g)).map((g): Link => [taskId, g]),
    unlink: current.filter((g) => !want.has(g)).map((g): Link => [taskId, g]),
  });
}
