/**
 * Dates for tasks. A task is *planned* (安排) for a day, a week, a month or a year — so a year-long focus, a monthly
 * focus and a weekly focus are all just tasks with a different granularity. Weeks are ISO weeks (Monday first).
 * All dates are local calendar days written `YYYY-MM-DD`.
 */
import { getLang, shortDay, t } from "../i18n";

export type PlanKind = "day" | "week" | "month" | "year";

export interface Plan {
  /** Canonical written form: `2026-11-20`, `2026-W47`, `2026-11` or `2026`. */
  raw: string;
  kind: PlanKind;
  /** First and last day of the period (inclusive). */
  start: string;
  end: string;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86400000;

export const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** A local date at noon (so daylight-saving shifts never move it to another day). */
export const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
export const todayStr = (now = new Date()) => ymd(now);
export const addDays = (s: string, n: number) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
export const daysBetween = (a: string, b: string) => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / DAY_MS);
const lastDayOfMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= lastDayOfMonth(y, m);

/** ISO week number and the ISO year it belongs to (2026-12-28 can be week 53 of 2026 or week 1 of 2027). */
export function isoWeekOf(day: string): { year: number; week: number } {
  const d = parseYmd(day);
  const idx = (d.getDay() + 6) % 7; // Monday = 0
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - idx + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4, 12);
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { year, week };
}
/** The Monday of an ISO week. */
export function weekStart(year: number, week: number): string {
  const jan4 = new Date(year, 0, 4, 12);
  const monday1 = new Date(jan4);
  monday1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  monday1.setDate(monday1.getDate() + (week - 1) * 7);
  return ymd(monday1);
}
export const weeksInYear = (year: number) => isoWeekOf(`${year}-12-28`).week;

/** The period of a given kind that contains `day`. */
export function planOf(kind: PlanKind, day: string): Plan {
  const [y, m] = day.split("-").map(Number);
  if (kind === "day") return { raw: day, kind, start: day, end: day };
  if (kind === "week") {
    const { year, week } = isoWeekOf(day);
    const start = weekStart(year, week);
    return { raw: `${year}-W${p2(week)}`, kind, start, end: addDays(start, 6) };
  }
  if (kind === "month") return { raw: `${y}-${p2(m)}`, kind, start: `${y}-${p2(m)}-01`, end: `${y}-${p2(m)}-${p2(lastDayOfMonth(y, m))}` };
  return { raw: `${y}`, kind, start: `${y}-01-01`, end: `${y}-12-31` };
}

/** Strict parser for the written forms. Anything else (including impossible dates) → null. */
export function parsePlan(raw: string): Plan | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]) ? planOf("day", s) : null;
  m = /^(\d{4})-W(\d{2})$/i.exec(s);
  if (m) {
    const year = +m[1];
    const week = +m[2];
    return week >= 1 && week <= weeksInYear(year) ? planOf("week", weekStart(year, week)) : null;
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return +m[2] >= 1 && +m[2] <= 12 ? planOf("month", `${m[1]}-${m[2]}-01`) : null;
  m = /^(\d{4})$/.exec(s);
  return m ? planOf("year", `${m[1]}-01-01`) : null;
}

/** The previous (-1) / next (+1) period of the same kind. */
export function shiftPlan(plan: Plan, delta: number): Plan {
  if (plan.kind === "day") return planOf("day", addDays(plan.start, delta));
  if (plan.kind === "week") return planOf("week", addDays(plan.start, 7 * delta));
  const [y, m] = plan.start.split("-").map(Number);
  if (plan.kind === "month") {
    const d = new Date(y, m - 1 + delta, 1, 12);
    return planOf("month", ymd(d));
  }
  return planOf("year", `${y + delta}-01-01`);
}

export const inPlan = (day: string, plan: Plan) => day >= plan.start && day <= plan.end;
/** Is the period already over, as seen from `today`? */
export const planPassed = (plan: Plan, today: string) => plan.end < today;
export const planIncludes = (plan: Plan, today: string) => inPlan(today, plan);

const WEEKDAYS = "一二三四五六日";

/**
 * Natural-language dates for the quick-add box and the pickers:
 * 今天 明天 后天 昨天 · 周五 本周五 下周一 · 本周 下周 · 本月 下月 · 今年 明年 · 3天后 2周后 · 11月20日 11-20 11/20 · 第47周 · 2026-11-20 2026-W47 2026-11 2026
 */
export function parseWhen(word: string, now = new Date()): Plan | null {
  const p = parseWhenAny(word, now);
  return p && (p.kind === "day" || p.kind === "week") ? p : null;
}

/** What a todo can be planned for: a day or a week (months and years belong to goals). */
export function parseTaskPlan(raw: string): Plan | null {
  const p = parsePlan(raw);
  return p && (p.kind === "day" || p.kind === "week") ? p : null;
}

const EN_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const EN_WORDS: Record<string, string> = {
  today: "今天", tomorrow: "明天", yesterday: "昨天", "day after tomorrow": "后天",
  "this week": "本周", "next week": "下周", "last week": "上周",
  "this month": "本月", "next month": "下月", "last month": "上月",
  "this year": "今年", "next year": "明年", "last year": "去年",
};
/** English and traditional-Chinese date words → the simplified-Chinese forms the rest of the parser knows. */
function canonicalWhen(raw: string): string {
  let w = raw.trim();
  w = w.replace(/[週後個這號禮]/g, (c) => ({ 週: "周", 後: "后", 個: "个", 這: "这", 號: "号", 禮: "礼" })[c] ?? c);
  if (!/[a-z]/i.test(w)) return w.replace(/\s+/g, "");
  w = w.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (w in EN_WORDS) return EN_WORDS[w];
  let m = /^(next |this |last )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(w);
  if (m) return `${m[1] ? { "next ": "下", "this ": "本", "last ": "上" }[m[1]] : ""}周${WEEKDAYS[EN_DAYS.indexOf(m[2])]}`;
  m = /^(?:in )?(\d{1,3}) ?(day|days|d|week|weeks|w|month|months)(?: later)?$/.exec(w);
  if (m) return `${m[1]}${m[2][0] === "d" ? "天" : m[2][0] === "w" ? "周" : "个月"}后`;
  return w.replace(/\s+/g, "");
}

function parseWhenAny(word: string, now: Date): Plan | null {
  const trimmed = word.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const today = todayStr(now);
  const iso = parsePlan(trimmed);
  if (iso) return iso;
  const w = canonicalWhen(word);
  if (!w) return null;
  const days: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1 };
  if (w in days) return planOf("day", addDays(today, days[w]));
  let m = /^(下|上|本|这)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(w);
  if (m) {
    const idx = WEEKDAYS.indexOf(m[2] === "天" ? "日" : m[2]);
    const thisMonday = planOf("week", today).start;
    const offset = m[1] === "下" ? 7 : m[1] === "上" ? -7 : 0;
    let target = addDays(thisMonday, offset + idx);
    if (!m[1] && target < today) target = addDays(target, 7); // a bare 周五 means the coming one
    return planOf("day", target);
  }
  const rel: Record<string, [PlanKind, number]> = {
    本周: ["week", 0], 这周: ["week", 0], 下周: ["week", 1], 上周: ["week", -1],
    本月: ["month", 0], 这个月: ["month", 0], 下月: ["month", 1], 下个月: ["month", 1], 上月: ["month", -1], 上个月: ["month", -1],
    今年: ["year", 0], 本年: ["year", 0], 明年: ["year", 1], 去年: ["year", -1],
  };
  if (w in rel) return shiftPlan(planOf(rel[w][0], today), rel[w][1]);
  m = /^(\d{1,3})(天|日|周|个月|月)后$/.exec(w);
  if (m) {
    const n = +m[1];
    if (m[2] === "天" || m[2] === "日") return planOf("day", addDays(today, n));
    if (m[2] === "周") return shiftPlan(planOf("week", today), n);
    return shiftPlan(planOf("month", today), n);
  }
  m = /^第(\d{1,2})周$/.exec(w);
  if (m) {
    const year = isoWeekOf(today).year;
    return +m[1] >= 1 && +m[1] <= weeksInYear(year) ? planOf("week", weekStart(year, +m[1])) : null;
  }
  m = /^(\d{1,2})月(\d{1,2})[日号]?$/.exec(w) ?? /^(\d{1,2})[-/.](\d{1,2})$/.exec(w);
  if (m) {
    let y = now.getFullYear();
    if (!validDay(y, +m[1], +m[2])) return null;
    let cand = `${y}-${p2(+m[1])}-${p2(+m[2])}`;
    if (cand < today) {
      y += 1; // a date that has already passed this year means next year's
      if (!validDay(y, +m[1], +m[2])) return null;
      cand = `${y}-${p2(+m[1])}-${p2(+m[2])}`;
    }
    return planOf("day", cand);
  }
  return null;
}

/** A single day only (for deadlines). */
export function parseDay(word: string, now = new Date()): string | null {
  const p = parseWhen(word, now);
  return p && p.kind === "day" ? p.start : null;
}

/** Short label for a chip: 今天 / 明天 / 11-20 · 本周 / 下周 / 第47周 · 本月 / 11月 · 今年 / 2027年. */
export function formatPlan(plan: Plan, now = new Date()): string {
  const today = todayStr(now);
  const here = planOf(plan.kind, today);
  const delta = plan.kind === "day" ? daysBetween(today, plan.start) : plan.start === here.start ? 0 : 99; // non-day kinds: 0 = the current period
  const [y, mo, d] = plan.start.split("-").map(Number);
  const thisYear = now.getFullYear();
  if (plan.kind === "day") {
    if (delta === 0) return t("date.today");
    if (delta === 1) return t("date.tomorrow");
    if (delta === 2) return t("date.dayAfter");
    if (delta === -1) return t("date.yesterday");
    return getLang() === "en" ? shortDay(plan.start, y !== thisYear) : y === thisYear ? `${mo}-${d}` : plan.start;
  }
  if (plan.kind === "week") {
    if (delta === 0) return t("date.thisWeek");
    const next = shiftPlan(here, 1).start === plan.start;
    const prev = shiftPlan(here, -1).start === plan.start;
    if (next) return t("date.nextWeek");
    if (prev) return t("date.lastWeek");
    const { year, week } = isoWeekOf(plan.start);
    return year === thisYear ? t("date.weekN", { n: week }) : t("date.weekNYear", { y: year, n: week });
  }
  if (plan.kind === "month") {
    if (delta === 0) return t("date.thisMonth");
    if (shiftPlan(here, 1).start === plan.start) return t("date.nextMonth");
    if (shiftPlan(here, -1).start === plan.start) return t("date.lastMonth");
    return y === thisYear ? t("date.monthN", { m: mo }) : t("date.monthNYear", { y, m: mo });
  }
  if (y === thisYear) return t("date.thisYear");
  if (y === thisYear + 1) return t("date.nextYear");
  if (y === thisYear - 1) return t("date.lastYear");
  return t("date.yearN", { y });
}

export const KIND_NAME: Record<PlanKind, string> = {
  get day() {
    return t("kind.day");
  },
  get week() {
    return t("kind.week");
  },
  get month() {
    return t("kind.month");
  },
  get year() {
    return t("kind.year");
  },
};
