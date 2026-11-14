/** Smart lists, filtering, sorting, grouping and progress for the task page. Pure functions over the task list. */
import type { Task } from "../core/types";
import { addDays, inPlan, isoWeekOf, parseTaskPlan, planOf, shiftPlan, todayStr, type Plan } from "./date";
import { isUnder } from "../notes/tags";
import { collate, t } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

export type ListKey = "inbox" | "today" | "week7" | "overdue" | "all" | "done" | "week";

export const LISTS: { key: ListKey; name: string }[] = [
  { key: "inbox", get name() { return t("list.inbox"); } },
  { key: "today", get name() { return t("list.today"); } },
  { key: "week7", get name() { return t("list.week7"); } },
  { key: "week", get name() { return t("list.week"); } },
  { key: "overdue", get name() { return t("list.overdue"); } },
  { key: "all", get name() { return t("list.all"); } },
  { key: "done", get name() { return t("list.done"); } },
];

export const planOfTask = (t: Task): Plan | null => (t.plan ? parseTaskPlan(t.plan) : null);

/** Overdue: the planned period is over, or the deadline has passed, and it is not done. */
export const isOverdue = (t: Task, today: string) => !t.done && ((!!t.planKind && !!t.planEnd && t.planEnd < today) || (!!t.deadline && t.deadline < today));

/** Is this task part of a smart list? `period` is the week being looked at (for the 本周 list). */
export function inList(t: Task, list: ListKey, today: string, period?: Plan): boolean {
  switch (list) {
    case "inbox":
      return !t.done && !t.plan;
    case "today":
      return !t.done && t.planKind === "day" && t.planStart <= today;
    case "week7":
      return !t.done && t.planKind === "day" && t.planStart >= today && t.planStart <= addDays(today, 6);
    case "overdue":
      return isOverdue(t, today);
    case "all":
      return !t.done;
    case "done":
      return t.done;
    default: {
      // the week list: tasks planned inside that week (the week itself or one of its days)
      const p = period ?? planOf("week", today);
      return !!t.planKind && t.planStart >= p.start && t.planEnd <= p.end;
    }
  }
}

export interface Filter {
  list: ListKey;
  period?: Plan;
  tags: string[];
  q: string;
}

export function filterTasks(tasks: Task[], f: Filter, today = todayStr()): Task[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!inList(t, f.list, today, f.period)) return false;
    if (f.tags.length && !f.tags.every((root) => t.tags.some((tag) => isUnder(tag, root)))) return false;
    if (q && !`${t.title}\n${t.note}\n${t.tags.join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export type SortKey = "plan" | "deadline" | "priority" | "created";
export type GroupKey = "none" | "plan" | "tag" | "priority";

const KIND_RANK: Record<string, number> = { day: 0, week: 1, month: 2, year: 3, "": 4 };
const byOrder = (a: Task, b: Task) => a.sort - b.sort || a.createdAt - b.createdAt;

export function sortTasks(tasks: Task[], key: SortKey): Task[] {
  const planKey = (t: Task) => (t.plan ? t.planStart : "9999-99-99");
  const deadlineKey = (t: Task) => t.deadline || "9999-99-99";
  const cmp: Record<SortKey, (a: Task, b: Task) => number> = {
    plan: (a, b) => planKey(a).localeCompare(planKey(b)) || KIND_RANK[a.planKind] - KIND_RANK[b.planKind] || b.priority - a.priority || byOrder(a, b),
    deadline: (a, b) => deadlineKey(a).localeCompare(deadlineKey(b)) || planKey(a).localeCompare(planKey(b)) || b.priority - a.priority || byOrder(a, b),
    priority: (a, b) => b.priority - a.priority || planKey(a).localeCompare(planKey(b)) || byOrder(a, b),
    created: (a, b) => b.createdAt - a.createdAt,
  };
  return [...tasks].sort(cmp[key]);
}

export const PLAN_BUCKETS = ["已过期", "今天", "明天", "本周", "下周", "本月", "以后", "未安排"];

/** Which bucket a task belongs to when grouping by plan. */
export function planBucket(t: Task, today = todayStr()): string {
  if (!t.plan) return "未安排";
  if (t.planEnd < today) return "已过期";
  const week = planOf("week", today);
  const nextWeek = shiftPlan(week, 1);
  if (t.planKind === "day") {
    if (t.planStart === today) return "今天";
    if (t.planStart === addDays(today, 1)) return "明天";
    if (inPlan(t.planStart, week)) return "本周";
    if (inPlan(t.planStart, nextWeek)) return "下周";
    if (t.planStart.slice(0, 7) === today.slice(0, 7)) return "本月";
    return "以后";
  }
  return t.planStart === week.start ? "本周" : t.planStart === nextWeek.start ? "下周" : "以后";
}

const BUCKET_KEYS: Record<string, string> = { 已过期: "bucket.overdue", 今天: "bucket.today", 明天: "bucket.tomorrow", 本周: "bucket.week", 下周: "bucket.nextWeek", 本月: "bucket.month", 以后: "bucket.later", 未安排: "bucket.unplanned", 无优先级: "bucket.noPriority", 无标签: "bucket.noTag", 低: "bucket.pri1", 中: "bucket.pri2", 高: "bucket.pri3" };
/** Display name of a group (the keys themselves stay as they are: they order and identify the groups). */
const groupTitle = (k: string) => (BUCKET_KEYS[k] ? t(BUCKET_KEYS[k] as Key) : k);

export interface Group {
  key: string;
  title: string;
  tasks: Task[];
}

export function groupTasks(tasks: Task[], by: GroupKey, today = todayStr()): Group[] {
  if (by === "none") return [{ key: "all", title: "", tasks }];
  const map = new Map<string, Task[]>();
  const add = (k: string, t: Task) => map.set(k, [...(map.get(k) ?? []), t]);
  for (const t of tasks) {
    if (by === "plan") add(planBucket(t, today), t);
    else if (by === "priority") add(["无优先级", "低", "中", "高"][t.priority] ?? "无优先级", t);
    else if (t.tags.length) {
      // by tag: under the task's own first-level tag (a task with several tags appears under each)
      for (const tag of new Set(t.tags.map((x) => x.split("/")[0]))) add(`#${tag}`, t);
    } else add("无标签", t);
  }
  const order = by === "plan" ? PLAN_BUCKETS : by === "priority" ? ["高", "中", "低", "无优先级"] : [];
  const keys = [...map.keys()].sort((a, b) => (order.length ? order.indexOf(a) - order.indexOf(b) : a === "无标签" ? 1 : b === "无标签" ? -1 : collate(a, b)));
  return keys.map((k) => ({ key: k, title: groupTitle(k), tasks: map.get(k)! }));
}

/** direct children of every task, in their own order */
export function childrenMap(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId) map.set(t.parentId, [...(map.get(t.parentId) ?? []), t]);
  for (const list of map.values()) list.sort(byOrder);
  return map;
}

/** Progress of a task = how many of the tasks below it (all levels) are done; null when it has nothing below it. */
export function progressOf(id: string, kids: Map<string, Task[]>): { done: number; total: number } | null {
  let done = 0;
  let total = 0;
  const walk = (pid: string) => {
    for (const c of kids.get(pid) ?? []) {
      total++;
      if (c.done) done++;
      walk(c.id);
    }
  };
  walk(id);
  return total ? { done, total } : null;
}

/** The rows to show: matched tasks whose parent is not itself matched (those appear nested under their parent). */
export function topLevel(matched: Task[]): Task[] {
  const ids = new Set(matched.map((t) => t.id));
  return matched.filter((t) => !t.parentId || !ids.has(t.parentId));
}

export interface TagRow {
  tag: string;
  count: number;
}

/** Open tasks per tag, every parent tag counting its children's tasks (what `buildTree` expects). */
export function tagCounts(tasks: Task[]): TagRow[] {
  const all = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (t.done) continue;
    for (const tag of t.tags) {
      const parts = tag.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!all.has(p)) all.set(p, new Set());
        all.get(p)!.add(t.id);
      }
    }
  }
  return [...all].map(([tag, ids]) => ({ tag, count: ids.size }));
}

export interface ListCounts extends Record<ListKey, number> {}
export function listCounts(tasks: Task[], today = todayStr()): ListCounts {
  const out = Object.fromEntries(LISTS.map((l) => [l.key, 0])) as ListCounts;
  for (const l of LISTS) out[l.key] = tasks.filter((t) => inList(t, l.key, today) && (l.key === "done" || !t.done)).length;
  return out;
}

/** The number on the 任务 tab: open tasks planned for today or earlier, plus anything overdue. */
export function dueCount(tasks: Task[], today = todayStr()): number {
  return tasks.filter((t) => !t.done && ((t.planKind === "day" && t.planStart <= today) || isOverdue(t, today))).length;
}

export const weekOf = (day: string) => isoWeekOf(day);
