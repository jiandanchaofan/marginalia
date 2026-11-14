import { addDays } from "../tasks/date";

/** Days to wait after a note reached each level. */
export const LADDER = [1, 3, 7, 14, 30, 60, 120, 240];
export const TOP = LADDER.length - 1;

/** 0 forgot, 1 fuzzy, 2 known. */
export type Rating = 0 | 1 | 2;

export interface ReviewItem {
  noteId: string;
  level: number;
  /** Day (YYYY-MM-DD) the note is due. */
  due: string;
  /** Day it was last read again ("" = never). */
  last: string;
  reps: number;
  lapses: number;
  suspended: boolean;
  /** Day the note entered the schedule. */
  added: string;
}

export interface LogRow {
  day: string;
  noteId: string;
  rating: Rating;
}

const clamp = (n: number) => Math.min(TOP, Math.max(0, n));

/** A small, fixed spread (±10%, decided by the note and the level) so notes read together do not all come due together. */
export function intervalDays(noteId: string, level: number): number {
  const base = LADDER[clamp(level)];
  let h = 0;
  for (const c of `${noteId}:${level}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const factor = 0.9 + (h % 21) / 100; // 0.90 .. 1.10
  return Math.max(1, Math.round(base * factor));
}

/** The note was read again on `today` and answered `rating`: known goes up a level, fuzzy stays, forgot goes down two. */
export function answer(item: ReviewItem, rating: Rating, today: string): ReviewItem {
  const level = clamp(rating === 2 ? item.level + 1 : rating === 1 ? item.level : item.level - 2);
  return { ...item, level, due: addDays(today, intervalDays(item.noteId, level)), last: today, reps: item.reps + 1, lapses: item.lapses + (rating === 0 ? 1 : 0) };
}

/** "Not today": comes back tomorrow, nothing else changes. */
export const postpone = (item: ReviewItem, today: string): ReviewItem => ({ ...item, due: addDays(today, 1) });

/** A note enters the schedule: its first reading is the day after it was written. */
export const newItem = (noteId: string, createdDay: string, today: string): ReviewItem => ({ noteId, level: 0, due: addDays(createdDay, 1), last: "", reps: 0, lapses: 0, suspended: false, added: today });

/** The day it is now for studying: a new day starts at `startHour` o'clock (so a note read at 1 a.m. still belongs to the day before). */
export function studyDay(now: Date, startHour: number): string {
  const d = new Date(now.getTime() - startHour * 3_600_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export interface Due {
  /** Today's notes in the order they are shown (what is left after the day's limit). */
  list: ReviewItem[];
  /** Notes answered today. */
  doneToday: number;
  /** Everything due, whatever the limit. */
  dueTotal: number;
}

/**
 * What to read today. Notes already learned and due come first (the most overdue first), then notes never read
 * (the most recently written first), so a long backlog never keeps the notes you are learning from coming back.
 * `cap` is the most notes per day (0 = no limit); answered notes count against it.
 */
export function pickDue(items: ReviewItem[], log: LogRow[], today: string, cap: number, allowed?: (id: string) => boolean): Due {
  const answered = new Set(log.filter((l) => l.day === today).map((l) => l.noteId));
  const due = items.filter((i) => !i.suspended && i.due <= today && !answered.has(i.noteId) && (!allowed || allowed(i.noteId)));
  const learned = due.filter((i) => i.reps > 0).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.last < b.last ? -1 : a.last > b.last ? 1 : a.noteId < b.noteId ? -1 : 1));
  const fresh = due.filter((i) => i.reps === 0).sort((a, b) => (a.due > b.due ? -1 : a.due < b.due ? 1 : a.noteId < b.noteId ? -1 : 1));
  const room = cap > 0 ? Math.max(0, cap - answered.size) : Infinity;
  return { list: [...learned, ...fresh].slice(0, room), doneToday: answered.size, dueTotal: due.length };
}

/** Days in a row, ending today or yesterday, on which at least one note was answered. */
export function streak(log: LogRow[], today: string): number {
  const days = new Set(log.map((l) => l.day));
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}
