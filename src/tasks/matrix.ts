/**
 * The four-quadrant view (important x urgent). Pure functions: which quadrant a task is in, what its status line says,
 * and which fields to change when it is dragged into another quadrant.
 *
 * Important = the priority is at or above `importantFrom` (medium by default).
 * Urgent = the nearest of the deadline and the end of the planned period is within `urgentDays` days (or already past).
 */
import type { Task } from "../core/types";
import type { Fields } from "./actions";
import { daysBetween, planOf } from "./date";

export interface MatrixCfg {
  /** Within this many days (or past) = urgent. */
  urgentDays: number;
  /** Priority from which a task is important: 2 = medium and high, 3 = high only. */
  importantFrom: 2 | 3;
}
export const DEFAULT_CFG: MatrixCfg = { urgentDays: 7, importantFrom: 2 };
const KEY = "reader:matrix";

export function loadCfg(): MatrixCfg {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const days = Number(v.urgentDays);
    return { urgentDays: Number.isFinite(days) && days >= 0 && days <= 365 ? Math.round(days) : DEFAULT_CFG.urgentDays, importantFrom: v.importantFrom === 3 ? 3 : 2 };
  } catch {
    return DEFAULT_CFG;
  }
}
export function saveCfg(c: MatrixCfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

/** The day the task is due: the earlier of its deadline and the end of its planned period; "" when it has neither. */
export function dueDay(t: Task): string {
  const days = [t.deadline, t.planKind ? t.planEnd : ""].filter(Boolean);
  return days.length ? days.reduce((a, b) => (a < b ? a : b)) : "";
}

/** Days from today until the task is due (negative = past); null without any date. */
export const daysLeft = (t: Task, today: string): number | null => {
  const d = dueDay(t);
  return d ? daysBetween(today, d) : null;
};

export const isImportant = (t: Task, c: MatrixCfg) => t.priority >= c.importantFrom;
export const isUrgent = (t: Task, today: string, c: MatrixCfg) => {
  const n = daysLeft(t, today);
  return n !== null && n <= c.urgentDays;
};

export interface Quadrant {
  important: boolean;
  urgent: boolean;
}
export const quadrantOf = (t: Task, today: string, c: MatrixCfg): Quadrant => ({ important: isImportant(t, c), urgent: isUrgent(t, today, c) });

export type Tone = "late" | "soon" | "idle" | "done";
/** The short status shown after the title: a tone for the dot and a word key with its argument. */
export function statusOf(t: Task, today: string): { tone: Tone; key: "mx.done" | "mx.late" | "mx.today" | "mx.tomorrow" | "mx.in" | "mx.none"; n?: number } {
  if (t.done) return { tone: "done", key: "mx.done" };
  const n = daysLeft(t, today);
  if (n === null) return { tone: "idle", key: "mx.none" };
  if (n < 0) return { tone: "late", key: "mx.late", n: -n };
  if (n === 0) return { tone: "soon", key: "mx.today" };
  if (n === 1) return { tone: "soon", key: "mx.tomorrow" };
  return { tone: "idle", key: "mx.in", n };
}

/**
 * What to change so the task lands in the quadrant: priority for the important axis; for the urgent axis a plan for today
 * (to make it urgent), or taking away the dates that fall inside the urgent window (to make it not urgent).
 * `prev` holds the old values of the same fields, to undo it.
 */
export function moveFields(t: Task, to: Quadrant, today: string, c: MatrixCfg): { fields: Fields; prev: Fields; parts: ("pri-up" | "pri-down" | "plan-today" | "clear-dates")[] } {
  const fields: Fields = {};
  const prev: Fields = {};
  const parts: ("pri-up" | "pri-down" | "plan-today" | "clear-dates")[] = [];
  const nowImportant = isImportant(t, c);
  if (to.important && !nowImportant) {
    fields.priority = 3;
    prev.priority = t.priority;
    parts.push("pri-up");
  } else if (!to.important && nowImportant) {
    fields.priority = c.importantFrom - 1;
    prev.priority = t.priority;
    parts.push("pri-down");
  }
  const nowUrgent = isUrgent(t, today, c);
  if (to.urgent && !nowUrgent) {
    fields.plan = planOf("day", today).raw;
    prev.plan = t.plan;
    parts.push("plan-today");
  } else if (!to.urgent && nowUrgent) {
    const within = (day: string) => !!day && daysBetween(today, day) <= c.urgentDays;
    if (t.planKind && within(t.planEnd)) {
      fields.plan = "";
      prev.plan = t.plan;
    }
    if (within(t.deadline)) {
      fields.deadline = "";
      prev.deadline = t.deadline;
    }
    parts.push("clear-dates");
  }
  return { fields, prev, parts };
}
