import type { Goal, Task } from "../core/types";
import { addDays, daysBetween, formatPlan, parsePlan, planOf, todayStr } from "./date";
import type { Link } from "./goalStore";
import { t } from "../i18n";

export const STATUS_NAME: Record<Goal["status"], string> = {
  get doing() {
    return t("goal.status.doing");
  },
  get done() {
    return t("goal.status.done");
  },
  get missed() {
    return t("goal.status.missed");
  },
  get dropped() {
    return t("goal.status.dropped");
  },
};

/** The period a goal covers, as a Plan (year or month). */
export const goalPlan = (g: Goal) => parsePlan(g.period);
export const goalLabel = (g: Goal) => {
  const p = goalPlan(g);
  return p ? formatPlan(p) : g.period;
};

/** Year goals are always typed in by hand; a month goal may count its supporting todos. */
export const effectiveMode = (g: Goal): "auto" | "manual" => (g.kind === "year" ? "manual" : g.mode);

export interface Progress {
  /** 0–100 */
  percent: number;
  done: number;
  total: number;
  mode: "auto" | "manual";
}

/** task ids supporting each goal */
export function supportMap(links: Link[], tasks: Task[]): Map<string, Task[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const m = new Map<string, Task[]>();
  for (const [tid, gid] of links) {
    const t = byId.get(tid);
    if (t) m.set(gid, [...(m.get(gid) ?? []), t]);
  }
  return m;
}

/** goal ids each task supports */
export function goalsOfMap(links: Link[], goals: Goal[]): Map<string, Goal[]> {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const m = new Map<string, Goal[]>();
  for (const [tid, gid] of links) {
    const g = byId.get(gid);
    if (g) m.set(tid, [...(m.get(tid) ?? []), g]);
  }
  return m;
}

export function progressOfGoal(g: Goal, support: Map<string, Task[]>): Progress {
  const list = support.get(g.id) ?? [];
  const done = list.filter((t) => t.done).length;
  const mode = effectiveMode(g);
  if (mode === "manual") return { percent: g.status === "done" ? 100 : g.percent, done, total: list.length, mode };
  return { percent: g.status === "done" ? 100 : list.length ? Math.round((done / list.length) * 100) : 0, done, total: list.length, mode };
}

/** How much of the goal's period has gone by, 0–1 (0 before it starts, 1 after it ends). */
export function elapsed(g: Goal, today = todayStr()): number {
  const p = goalPlan(g);
  if (!p) return 0;
  if (today < p.start) return 0;
  if (today > p.end) return 1;
  return (daysBetween(p.start, today) + 1) / (daysBetween(p.start, p.end) + 1);
}

/**
 * How far along a goal should be by now, 0–1. Time counts from the day the goal was made, not from the start of its period:
 * a goal written down in the middle of the month is not "behind" for the half month that went by before it existed.
 */
export function expected(g: Goal, today = todayStr()): number {
  const p = goalPlan(g);
  if (!p) return 0;
  const d = new Date(g.createdAt);
  const made = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = made > p.start ? made : p.start;
  if (today < from) return 0;
  if (today > p.end) return 1;
  return (daysBetween(from, today) + 1) / (daysBetween(from, p.end) + 1);
}

export type Pace = "closed" | "future" | "late" | "ok" | "over";

/** closed = already decided; future = not started; late = well behind the calendar; over = period ended but still open. */
export function paceOf(g: Goal, progress: Progress, today = todayStr()): Pace {
  if (g.status !== "doing") return "closed";
  const p = goalPlan(g);
  if (!p) return "ok";
  if (today < p.start) return "future";
  if (today > p.end) return "over";
  return progress.percent < expected(g, today) * 100 - 15 ? "late" : "ok";
}

export const PACE_TEXT: Record<Pace, string> = {
  closed: "",
  get future() {
    return t("goal.pace.future");
  },
  get late() {
    return t("goal.pace.late");
  },
  get ok() {
    return t("goal.pace.ok");
  },
  get over() {
    return t("goal.pace.over");
  },
};

/** goals of one kind in one period, in the order they were made */
export const goalsIn = (goals: Goal[], kind: Goal["kind"], period: string) => goals.filter((g) => g.kind === kind && g.period === period).sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);

/** still "doing" although their period is over */
export const toReview = (goals: Goal[], today = todayStr()) =>
  goals.filter((g) => g.status === "doing" && (goalPlan(g)?.end ?? "9999") < today).sort((a, b) => (goalPlan(a)!.start < goalPlan(b)!.start ? 1 : -1));

/** the same kind of period one step later: 2026-11 → 2026-12, 2026 → 2027 */
export const nextPeriod = (g: Goal) => {
  const p = goalPlan(g)!;
  return planOf(g.kind, addDays(p.end, 1)).raw;
};

/** What a review note says about a finished goal. */
export function reviewText(g: Goal, tasks: Task[]): string {
  const done = tasks.filter((t) => t.done);
  const open = tasks.filter((t) => !t.done);
  const lines = [t("goal.review.title", { label: goalLabel(g), title: g.title }), "", t("goal.review.result", { status: STATUS_NAME[g.status] }), ""];
  if (done.length) lines.push(t("goal.review.done"), ...done.map((x) => `- [x] ${x.title}`), "");
  if (open.length) lines.push(t("goal.review.open"), ...open.map((x) => `- ${x.title}`), "");
  lines.push(t("goal.review.learned"));
  return lines.join("\n");
}
