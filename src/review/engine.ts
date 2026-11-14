import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../settings";
import { settingsStore } from "../platform";
import { notesStore, dayKey, type NoteHit } from "../notes/store";
import { familyOf } from "../notes/aliases";
import { isUnder, parseTags } from "../notes/tags";
import { newItem, pickDue, studyDay, type Rating, type ReviewItem } from "./schedule";
import { reviewStore } from "./store";

export const reviewSettings = (): Settings => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS));
export const reviewToday = (s: Settings = reviewSettings()) => studyDay(new Date(), s.reviewDayStart ?? 4);

/** Tags whose notes are not reviewed (every spelling of a family counts, children too). */
export function excludedTags(s: Settings): string[] {
  return [...new Set((s.reviewExclude ?? []).flatMap((t) => familyOf(t) ?? [t]))];
}
export const isExcluded = (note: NoteHit["note"], excluded: string[]) => parseTags(note.note).some((t) => excluded.some((x) => isUnder(t, x)));

/** Whether a note can be reviewed at all: it holds something to read. */
export const hasContent = (n: NoteHit["note"]) => n.note.replace(/#\S+/g, "").trim() !== "" || !!n.anchor.exact?.trim() || !!n.anchor.region || !!n.images?.length;

/** Put every note that is not in the schedule yet into it (the first reading is the day after it was written). */
export async function ensureReviewItems(): Promise<number> {
  const s = reviewSettings();
  if (s.reviewOn === false) return 0;
  const today = reviewToday(s);
  const have = new Map((await reviewStore.all()).items.map((i) => [i.noteId, i]));
  const hits = (await notesStore.query({ sort: "time", limit: -1 })).items;
  const excluded = excludedTags(s);
  const put: ReviewItem[] = [];
  for (const h of hits) {
    const item = have.get(h.note.id);
    if (!item) {
      if (hasContent(h.note) && !isExcluded(h.note, excluded)) put.push(newItem(h.note.id, dayKey(h.note.createdAt), today));
    } else if (!item.suspended && isExcluded(h.note, excluded)) {
      put.push({ ...item, suspended: true }); // its tag was put on the "do not review" list
    }
  }
  await reviewStore.put(put);
  return put.filter((i) => !i.suspended).length;
}

export interface TodayQueue {
  hits: NoteHit[];
  doneToday: number;
  dueTotal: number;
  today: string;
}

/** Today's notes to read: what is due, minus the excluded tags, limited to the rest of the day's allowance. */
export async function todayQueue(): Promise<TodayQueue> {
  const s = reviewSettings();
  const today = reviewToday(s);
  const { items, log } = await reviewStore.all();
  const excluded = excludedTags(s);
  const all = pickDue(items, log, today, 0); // everything due, in the order it would be shown
  const hits = await notesStore.byIds(all.list.slice(0, 200).map((i) => i.noteId));
  const byId = new Map(hits.map((h) => [h.note.id, h]));
  const usable = new Set(hits.filter((h) => !isExcluded(h.note, excluded)).map((h) => h.note.id));
  const due = pickDue(items, log, today, s.reviewCap ?? 5, (id) => usable.has(id));
  return {
    hits: due.list.map((i) => byId.get(i.noteId)).filter((h): h is NoteHit => !!h),
    doneToday: due.doneToday,
    dueTotal: usable.size + Math.max(0, all.dueTotal - 200),
    today,
  };
}

/** The reader answered for a note. */
export async function answerNote(noteId: string, rating: Rating) {
  const { answer } = await import("./schedule");
  const s = reviewSettings();
  const today = reviewToday(s);
  const item = (await reviewStore.all()).items.find((i) => i.noteId === noteId);
  if (!item) return;
  await reviewStore.put([answer(item, rating, today)]);
  await reviewStore.logAnswer(today, noteId, rating);
}

export async function postponeNote(noteId: string) {
  const { postpone } = await import("./schedule");
  const item = (await reviewStore.all()).items.find((i) => i.noteId === noteId);
  if (item) await reviewStore.put([postpone(item, reviewToday())]);
}

export async function stopReviewing(noteId: string) {
  const item = (await reviewStore.all()).items.find((i) => i.noteId === noteId);
  if (item) await reviewStore.put([{ ...item, suspended: true }]);
}
