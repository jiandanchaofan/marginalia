import { FREE_BOOK, type Goal, type Task } from "../core/types";
import type { NoteHit } from "../notes/store";
import { familyOf } from "../notes/aliases";
import { isUnder, parseTags } from "../notes/tags";

/** Every spelling of a topic: its alias family, or just the tag itself. */
export const topicTags = (tag: string): string[] => familyOf(tag) ?? [tag];

/** Whether a tag belongs to the topic (the topic itself, a child of it, or a child of an alias). */
export const inTopic = (tag: string, roots: string[], withChildren = true) => roots.some((r) => (withChildren ? isUnder(tag, r) : tag === r));

export const tasksOfTopic = (tasks: Task[], roots: string[], withChildren = true): Task[] => tasks.filter((t) => t.tags.some((x) => inTopic(x, roots, withChildren)));

/** Notes that carry the topic (sub-tags only when asked for). */
export const notesOfTopic = (hits: NoteHit[], roots: string[], withChildren = true): NoteHit[] => (withChildren ? hits : hits.filter((h) => parseTags(h.note.note).some((x) => inTopic(x, roots, false))));

/** The books the topic's notes come from, most notes first (notes written on their own are not a book). */
export function booksOfTopic(hits: NoteHit[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const h of hits) if (h.bookId !== FREE_BOOK) m.set(h.bookId, (m.get(h.bookId) ?? 0) + 1);
  return [...m].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}

/** Goals that the topic's to-dos support, with how many of those to-dos each one has. */
export function goalsOfTopic(tasks: Task[], links: [string, string][], goals: Goal[]): { goal: Goal; count: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const byGoal = new Map<string, number>();
  for (const [tid, gid] of links) if (ids.has(tid)) byGoal.set(gid, (byGoal.get(gid) ?? 0) + 1);
  return goals
    .filter((g) => byGoal.has(g.id))
    .map((goal) => ({ goal, count: byGoal.get(goal.id)! }))
    .sort((a, b) => (a.goal.period < b.goal.period ? 1 : -1));
}

/** Direct sub-tags of the topic, with their note counts. */
export function childTags(all: { tag: string; count: number }[], tag: string): { tag: string; count: number }[] {
  const depth = tag.split("/").length + 1;
  return all.filter((x) => x.tag.startsWith(`${tag}/`) && x.tag.split("/").length === depth).sort((a, b) => b.count - a.count);
}
