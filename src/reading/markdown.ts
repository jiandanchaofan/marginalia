import type { BookRecord } from "../core/types";
import { docTitle } from "../host/registry";
import { t } from "../i18n";
import type { ReadingDay } from "./store";
import { dayTotals, fmtSecs } from "./stats";

const READ_DAY = 60;
const pct = (p: number) => Math.round(p * 100);

/**
 * The reading log as Markdown for the backup: a one-line total, then for every book its totals and one line per day read
 * (day, time, progress at the start and end of that day).
 */
export function readingToMarkdown(rows: ReadingDay[], books: Map<string, BookRecord>): string {
  if (!rows.length) return "";
  const daysRead = [...dayTotals(rows)].filter(([, s]) => s >= READ_DAY).length;
  const lines = [`- ${t("md.rsum", { days: daysRead, time: fmtSecs(rows.reduce((s, r) => s + r.secs, 0)) })}`, ""];
  const ids = [...new Set(rows.map((r) => r.bookId))];
  const perBook = ids
    .map((id) => {
      const mine = rows.filter((r) => r.bookId === id).sort((a, b) => (a.day < b.day ? -1 : 1));
      return { id, mine, secs: mine.reduce((s, r) => s + r.secs, 0) };
    })
    .sort((a, b) => b.secs - a.secs);
  for (const { id, mine, secs } of perBook) {
    const title = books.get(id)?.title ?? (docTitle(id) || t("kind.removedBook"));
    lines.push(`## ${t("kind.bookQuote", { title })}`, "");
    const days = mine.filter((r) => r.secs >= READ_DAY).length;
    lines.push(`- ${t("md.rbook", { time: fmtSecs(secs), days, a: pct(mine[0].p0), b: pct(Math.max(...mine.map((r) => r.p1))) })}`);
    for (const r of mine) lines.push(`- ${t("md.rday", { day: r.day, time: fmtSecs(r.secs), a: pct(r.p0), b: pct(r.p1) })}`);
    lines.push("");
  }
  return lines.join("\n");
}
