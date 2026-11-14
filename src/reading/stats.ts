import type { ReadingDay } from "./store";
import { addDays } from "../tasks/date";
import { t } from "../i18n";

/** A day with at least this many seconds of reading counts as a day read. */
const READ_DAY = 60;

export interface BookStat {
  secs: number;
  /** Days on which the book was read. */
  days: number;
  /** Percent of the book per hour, over the last 7 days read (null when there is too little to say). */
  speed: number | null;
  /** Expected day of finishing at that pace (null when unknown or already finished). */
  eta: string | null;
  /** Minutes read on each of the last `span` days, oldest first. */
  recent: { day: string; mins: number }[];
}

export function bookStat(rows: ReadingDay[], bookId: string, progress: number, today: string, span = 14): BookStat {
  const mine = rows.filter((r) => r.bookId === bookId).sort((a, b) => (a.day < b.day ? -1 : 1));
  const secs = mine.reduce((s, r) => s + r.secs, 0);
  const read = mine.filter((r) => r.secs >= READ_DAY);
  const last = read.slice(-7);
  const lastSecs = last.reduce((s, r) => s + r.secs, 0);
  const gained = last.reduce((s, r) => s + Math.max(0, r.p1 - r.p0), 0);
  const speed = read.length >= 3 && lastSecs >= 600 && gained > 0 ? (gained * 100) / (lastSecs / 3600) : null;
  let eta: string | null = null;
  if (speed && progress < 0.995) {
    const avgSecs = lastSecs / last.length;
    const inLast14 = mine.filter((r) => r.secs >= READ_DAY && r.day > addDays(today, -14)).length;
    const freq = Math.max(1 / 14, inLast14 / 14);
    const hours = ((1 - progress) * 100) / speed;
    eta = addDays(today, Math.ceil(((hours * 3600) / avgSecs) / freq));
  }
  const byDay = new Map(mine.map((r) => [r.day, r.secs]));
  const recent = Array.from({ length: span }, (_, i) => {
    const day = addDays(today, i - (span - 1));
    return { day, mins: Math.round((byDay.get(day) ?? 0) / 60) };
  });
  return { secs, days: read.length, speed, eta, recent };
}

/** Seconds read on each day, all books together. */
export function dayTotals(rows: ReadingDay[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0) + r.secs);
  return m;
}

/** "3 小时 20 分" style pieces: whole hours and the minutes left over. */
export const hm = (secs: number) => ({ h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60) });

/** The week (first day .. last day) that contains `day`; `weekStart` is 1 for Monday, 0 for Sunday. */
export function weekRange(day: string, weekStart: 0 | 1): { start: string; end: string } {
  const dow = new Date(`${day}T00:00:00`).getDay(); // 0 = Sunday
  const back = (dow - weekStart + 7) % 7;
  const start = addDays(day, -back);
  return { start, end: addDays(start, 6) };
}

export interface BookWeek {
  bookId: string;
  secs: number;
  from: number;
  to: number;
  /** Reached the end of the book during this week. */
  finished: boolean;
}
export interface WeekStats {
  secs: number;
  days: number;
  /** Seconds read on each of the 7 days. */
  perDay: number[];
  books: BookWeek[];
}

export function weekStats(rows: ReadingDay[], start: string, end: string): WeekStats {
  const inRange = rows.filter((r) => r.day >= start && r.day <= end);
  const perDay = Array.from({ length: 7 }, (_, i) => inRange.filter((r) => r.day === addDays(start, i)).reduce((s, r) => s + r.secs, 0));
  const ids = [...new Set(inRange.map((r) => r.bookId))];
  const books = ids
    .map((bookId) => {
      const mine = inRange.filter((r) => r.bookId === bookId).sort((a, b) => (a.day < b.day ? -1 : 1));
      const from = mine[0].p0;
      const to = Math.max(...mine.map((r) => r.p1));
      return { bookId, secs: mine.reduce((s, r) => s + r.secs, 0), from, to, finished: from < 0.99 && to >= 0.99 };
    })
    .sort((a, b) => b.secs - a.secs);
  return { secs: perDay.reduce((s, n) => s + n, 0), days: perDay.filter((n) => n >= READ_DAY).length, perDay, books };
}

/** 3 h 20 min / 45 min / 0 min, in the current language. */
export function fmtSecs(secs: number): string {
  const { h, m } = hm(secs);
  if (h > 0 && m > 0) return t("time.hm", { h, m });
  if (h > 0) return t("time.h", { h });
  if (secs > 0) return t("time.m", { m: Math.max(1, m) });
  return t("time.zero");
}
