import { useMemo } from "react";
import { useTasks } from "../tasks/useTasks";
import { useGlobalTags, type TagInfo } from "./store";

/**
 * The one list of multi-level tags for the whole app: the tags of the notes, plus tags that only exist on todos made
 * on the 任务 page (todos written in notes carry their tags in the note text, so they are already counted). It feeds
 * every tag completion. The tag *trees* still count what belongs to them: the notes page counts notes, the task
 * page counts todos.
 */
export function mergeTagInfos(noteTags: TagInfo[], taskOnlyTags: string[]): TagInfo[] {
  const map = new Map<string, TagInfo>(noteTags.map((t) => [t.tag, { ...t }]));
  const bump = (tag: string, own: boolean) => {
    const cur = map.get(tag) ?? { tag, count: 0, own: 0, pinned: false };
    cur.count += 1;
    if (own) cur.own += 1;
    map.set(tag, cur);
  };
  for (const t of taskOnlyTags) {
    const parts = t.split("/");
    for (let i = 1; i <= parts.length; i++) bump(parts.slice(0, i).join("/"), i === parts.length);
  }
  return [...map.values()];
}

export function useAllTags(): TagInfo[] {
  const noteTags = useGlobalTags();
  const tasks = useTasks();
  return useMemo(() => mergeTagInfos(noteTags, tasks.filter((t) => !t.sourceNoteId).flatMap((t) => t.ownTags)), [noteTags, tasks]);
}
