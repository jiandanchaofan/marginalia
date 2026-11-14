import { DEFAULT_WEEK_TAG } from "../settings";
import { reviewTag, weekTag } from "../tasks/words";

/**
 * Some tags are written by the app itself and used to be written in the interface language (or can be changed in the
 * settings). Notes written before keep their old spelling, but the tag list shows each such family as one tag and a
 * click on it finds all of them.
 */
const TODO_REVIEW = ["Status/待办复盘", "Status/待辦複盤", "Status/Todo-review"];
const LEGACY_WEEK = ["回顾/周", "回顧/週", "Review/Week"];
const USED = "reader:weekly-tags";

export const usedWeekTags = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(USED) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};
/** Remember a tag a weekly review was written with (the setting can change later). */
export const rememberWeekTag = (tag: string) => {
  try {
    localStorage.setItem(USED, JSON.stringify([...new Set([...usedWeekTags(), tag])]));
  } catch {
    /* storage unavailable */
  }
};

/** Every tag a weekly review may carry: the one set now, the default, the ones used before, and the old per-language ones. */
export const weekReviewTags = () => [...new Set([weekTag(), DEFAULT_WEEK_TAG, ...usedWeekTags(), ...LEGACY_WEEK])];

/** The families; the first tag of each is the one that is shown. */
export function aliasGroups(): string[][] {
  return [[...new Set([reviewTag(), ...TODO_REVIEW])], weekReviewTags()];
}

/** member → the tag shown for its family (members that are already the shown tag are left out). */
export function aliasPairs(): [string, string][] {
  const out: [string, string][] = [];
  for (const [shown, ...rest] of aliasGroups()) for (const m of rest) if (m !== shown) out.push([m, shown]);
  return out;
}

/** All spellings of the family `tag` belongs to, or null when it has none. */
export function familyOf(tag: string): string[] | null {
  return aliasGroups().find((g) => g.includes(tag)) ?? null;
}
