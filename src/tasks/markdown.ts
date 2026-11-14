import type { Goal, Task } from "../core/types";
import type { Link } from "./goalStore";
import { STATUS_NAME, effectiveMode, progressOfGoal, supportMap } from "./goals";
import { formatTodoLine } from "./parse";
import { monthName, t } from "../i18n";


/**
 * The goals and the standalone todos as Markdown, for the Markdown backup. Todos written inside notes are already in
 * those notes, so only their titles appear here (under the goals they support).
 */
export function tasksToMarkdown(tasks: Task[], goals: Goal[], links: Link[]): string {
  const support = supportMap(links, tasks);
  const lines: string[] = [];

  if (goals.length) {
    lines.push(`## ${t("md.goals")}`, "");
    const groups = [...new Set(goals.map((g) => `${g.kind}:${g.period}`))].sort().reverse();
    for (const key of groups) {
      const list = goals.filter((g) => `${g.kind}:${g.period}` === key).sort((a, b) => a.createdAt - b.createdAt);
      const first = list[0];
      lines.push(first.kind === "year" ? `### ${t("md.yearGoal", { period: first.period })}` : `### ${t("md.monthGoal", { name: monthName(first.period.slice(0, 4), first.period.slice(5, 7), true) })}`, "");
      for (const g of list) {
        const pr = progressOfGoal(g, support);
        const mode = effectiveMode(g);
        lines.push(`- **${g.title}**（${STATUS_NAME[g.status]} · ${pr.percent}% · ${t(mode === "auto" ? "md.mode.auto" : "md.mode.manual")}）`);
        if (g.note.trim()) lines.push(...g.note.trim().split("\n").map((l) => `  > ${l}`));
        const parent = g.parentId ? goals.find((x) => x.id === g.parentId) : null;
        if (parent) lines.push(`  - ${t("md.supports", { title: parent.title })}`);
        for (const t of support.get(g.id) ?? []) lines.push(`  - [${t.done ? "x" : " "}] ${t.title}`);
      }
      lines.push("");
    }
  }

  const standalone = tasks.filter((t) => !t.sourceNoteId);
  if (standalone.length) {
    lines.push(`## ${t("md.tasks")}`, "");
    const byParent = new Map<string | null, Task[]>();
    for (const t of standalone) byParent.set(t.parentId, [...(byParent.get(t.parentId) ?? []), t]);
    const ids = new Set(standalone.map((t) => t.id));
    const walk = (parent: string | null, depth: number) => {
      for (const t of (byParent.get(parent) ?? []).sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)) {
        lines.push(formatTodoLine({ indent: depth, done: t.done, title: t.title, tags: t.ownTags, plan: t.plan, deadline: t.deadline, priority: t.priority }));
        if (t.note.trim()) lines.push(...t.note.trim().split("\n").map((l) => `${"  ".repeat(depth + 1)}> ${l}`));
        walk(t.id, depth + 1);
      }
    };
    walk(null, 0);
    // subtasks whose parent is not standalone cannot happen (a subtask lives under its parent's source), but never lose one
    for (const t of standalone) if (t.parentId && !ids.has(t.parentId)) lines.push(formatTodoLine({ indent: 0, done: t.done, title: t.title, tags: t.ownTags, plan: t.plan, deadline: t.deadline, priority: t.priority }));
    lines.push("");
  }
  return lines.join("\n");
}
