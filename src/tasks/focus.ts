import type { Task } from "../core/types";
import { formatPlan, parsePlan } from "./date";

export interface TopicSummary {
  tag: string;
  done: number;
  total: number;
  /** how many of its tasks are planned in each period, e.g. "2026 年" 2 · "11 月" 3 */
  periods: { raw: string; name: string; count: number }[];
}

export const isUnderTag = (tag: string, root: string) => tag === root || tag.startsWith(root + "/");

export function topicSummary(tasks: Task[], tag: string): TopicSummary {
  const mine = tasks.filter((t) => t.tags.some((x) => isUnderTag(x, tag)));
  const counts = new Map<string, number>();
  for (const t of mine) if (t.plan) counts.set(t.plan, (counts.get(t.plan) ?? 0) + 1);
  const periods = [...counts]
    .map(([raw, count]) => ({ raw, count, p: parsePlan(raw)! }))
    .filter((x) => x.p && x.p.kind !== "day")
    .sort((a, b) => (a.p.start < b.p.start ? -1 : 1))
    .map(({ raw, count, p }) => ({ raw, name: formatPlan(p), count }));
  return { tag, done: mine.filter((t) => t.done).length, total: mine.length, periods };
}
