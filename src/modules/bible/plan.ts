/**
 * Reading plans: which chapters to read on which day. Pure functions; the host turns the result into to-dos.
 * A day's share is balanced by the number of verses (so a day of Psalm 117 is not as light as a day of Psalm 119).
 */
import type { PlannedTask } from "../../host/sdk";
import { BIBLE_BOOKS, bookInfo } from "./books";
import { loadPack } from "./packs";

export interface ChapterRef {
  book: string;
  chapter: number;
}

/** The tag every reading-plan to-do carries. */
export const PLAN_TAG = "Bible";

export const allChapters = (): ChapterRef[] => BIBLE_BOOKS.flatMap((b) => Array.from({ length: b.chapters }, (_, i) => ({ book: b.id, chapter: i + 1 })));

const indexOf = (all: ChapterRef[], c: ChapterRef) => all.findIndex((x) => x.book === c.book && x.chapter === c.chapter);

/** The chapters from `from` to `to`, in the order of the Bible (empty if they are the wrong way round). */
export function chaptersBetween(from: ChapterRef, to: ChapterRef): ChapterRef[] {
  const all = allChapters();
  const a = indexOf(all, from);
  const b = indexOf(all, to);
  return a < 0 || b < a ? [] : all.slice(a, b + 1);
}

/**
 * Cut the chapters into `days` runs of about equal weight, in order, each with at least one chapter. `days` larger than
 * the number of chapters is cut down to it.
 */
export function splitDays(chapters: ChapterRef[], weights: number[], days: number): ChapterRef[][] {
  const n = chapters.length;
  const d = Math.max(1, Math.min(days, n));
  const total = weights.reduce((x, y) => x + y, 0);
  const target = total / d;
  const out: ChapterRef[][] = Array.from({ length: d }, () => []);
  let day = 0;
  let sum = 0;
  chapters.forEach((c, k) => {
    out[day].push(c);
    sum += weights[k];
    const chaptersLeft = n - k - 1;
    const daysLeft = d - day - 1;
    if (daysLeft > 0 && (sum >= target || chaptersLeft <= daysLeft)) {
      day++;
      sum = 0;
    }
  });
  return out.filter((x) => x.length);
}

/** "约翰福音 3–5", "创世记 50 – 出埃及记 2", "诗篇 117". */
export function dayLabel(chs: ChapterRef[]): string {
  const name = (b: string) => bookInfo(b)?.zh ?? b;
  const first = chs[0];
  const last = chs[chs.length - 1];
  if (first.book === last.book) return first.chapter === last.chapter ? `${name(first.book)} ${first.chapter}` : `${name(first.book)} ${first.chapter}–${last.chapter}`;
  return `${name(first.book)} ${first.chapter} – ${name(last.book)} ${last.chapter}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `days` dates from `start` ("YYYY-MM-DD"), leaving out Sundays when asked. */
export function schedule(start: string, days: number, skipSunday: boolean): string[] {
  const [y, m, d] = start.split("-").map(Number);
  const cur = new Date(y, m - 1, d, 12);
  const out: string[] = [];
  while (out.length < days) {
    if (!(skipSunday && cur.getDay() === 0)) out.push(ymd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export interface PlanPreset {
  id: string;
  name: string;
  about: string;
  /** The chapters to read and over how many days (days may be changed for the ones that allow it). */
  range(params: PlanParams): { chapters: ChapterRef[]; days: number };
  /** The person can set the number of days. */
  daysFree?: boolean;
  /** The person picks a book (or a from / to). */
  needs?: "book" | "span";
}

export interface PlanParams {
  preset: string;
  start: string;
  skipSunday: boolean;
  days?: number;
  book?: string;
  from?: ChapterRef;
  to?: ChapterRef;
}

const OT = BIBLE_BOOKS.filter((b) => b.ot);
const NT = BIBLE_BOOKS.filter((b) => !b.ot);
const last = (list: typeof BIBLE_BOOKS) => list[list.length - 1];

export const PRESETS: PlanPreset[] = [
  { id: "bible-year", name: "一年读完圣经", about: "从创世记读到启示录，约 365 天，每天约 3–4 章。", range: () => ({ chapters: allChapters(), days: 365 }) },
  { id: "nt-90", name: "三个月读完新约", about: "新约 260 章，90 天，每天约 3 章。", range: () => ({ chapters: chaptersBetween({ book: NT[0].id, chapter: 1 }, { book: last(NT).id, chapter: last(NT).chapters }), days: 90 }) },
  { id: "ot-year", name: "一年读完旧约", about: "旧约 929 章，365 天，每天约 2–3 章。", range: () => ({ chapters: chaptersBetween({ book: OT[0].id, chapter: 1 }, { book: last(OT).id, chapter: last(OT).chapters }), days: 365 }) },
  {
    id: "book",
    name: "读一卷书",
    about: "选一卷书，按你定的天数读完。",
    needs: "book",
    daysFree: true,
    range: (p) => {
      const info = bookInfo(p.book ?? "") ?? NT[3];
      const chapters = chaptersBetween({ book: info.id, chapter: 1 }, { book: info.id, chapter: info.chapters });
      return { chapters, days: Math.max(1, Math.min(p.days ?? chapters.length, chapters.length)) };
    },
  },
  {
    id: "custom",
    name: "自定义范围",
    about: "从哪一章读到哪一章，用几天。",
    needs: "span",
    daysFree: true,
    range: (p) => {
      const chapters = p.from && p.to ? chaptersBetween(p.from, p.to) : [];
      return { chapters, days: Math.max(1, Math.min(p.days ?? chapters.length, Math.max(chapters.length, 1))) };
    },
  },
];

/** The to-dos of a plan: one a day, `读经：约翰福音 3–5`, tagged #Bible. */
export async function buildPlan(params: PlanParams): Promise<PlannedTask[]> {
  const preset = PRESETS.find((p) => p.id === params.preset);
  if (!preset) return [];
  const { chapters, days } = preset.range(params);
  if (!chapters.length) return [];
  // the number of verses in each chapter, from the Chinese text that comes with the app
  const rows = await loadPack("cuv-hans");
  const count = new Map<string, number>();
  for (const [book, list] of Object.entries(rows.books)) for (const [c, v] of list) if (v > 0) count.set(`${book}.${c}`, (count.get(`${book}.${c}`) ?? 0) + 1);
  const runs = splitDays(chapters, chapters.map((c) => count.get(`${c.book}.${c.chapter}`) ?? 1), days);
  const dates = schedule(params.start, runs.length, params.skipSunday);
  return runs.map((chs, i) => ({ title: `读经：${dayLabel(chs)}`, day: dates[i], tags: [PLAN_TAG] }));
}
