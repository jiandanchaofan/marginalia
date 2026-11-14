import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDate, t } from "../i18n";
import { addDays, todayStr } from "../tasks/date";
import { useReading } from "./store";
import { dayTotals, fmtSecs } from "./stats";
import "./reading.css";

const CELL = 12; // the same squares as the notes heatmap
const GAP = 3;
const level = (secs: number) => (secs < 60 ? 0 : secs < 900 ? 1 : secs < 1800 ? 2 : secs < 3600 ? 3 : 4);

/** One square per day, a column per week (Monday first), shaded by how long was read. Shown on the shelf page. */
export function ReadingHeat() {
  const rows = useReading();
  const box = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(26);
  const legend = [0, 1, 2, 3, 4];
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWeeks(Math.max(8, Math.min(26, Math.floor((el.clientWidth + GAP) / (CELL + GAP)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const totals = useMemo(() => dayTotals(rows), [rows]);
  const today = todayStr();
  const cells = useMemo(() => {
    const dow = (new Date(`${today}T00:00:00`).getDay() + 6) % 7; // Monday = 0
    const start = addDays(today, -dow - (weeks - 1) * 7);
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const day = addDays(start, i);
      return { day, secs: totals.get(day) ?? 0, future: day > today };
    });
  }, [weeks, totals, today]);
  const first = cells[0].day;
  const inView = [...totals].filter(([d]) => d >= first && d <= today && (totals.get(d) ?? 0) >= 60);
  const sum = inView.reduce((s, [, n]) => s + n, 0);
  if (!rows.length) return null;
  return (
    <div className="rheat">
      <div className="rheat-head" title={t("rh.range", { n: weeks })}>
        <b>{t("rh.title")}</b>
        <span className="sp">{t("rh.total", { days: inView.length, time: fmtSecs(sum) })}</span>
      </div>
      <div ref={box}>
        <div className="rheat-grid" style={{ gridTemplateColumns: `repeat(${weeks}, ${CELL}px)`, gridTemplateRows: `repeat(7, ${CELL}px)` }}>
          {cells.map((c) =>
            c.future ? (
              <i key={c.day} className="blank" />
            ) : (
              <i
                key={c.day}
                className={`${c.secs ? `l${level(c.secs)}` : ""} ${c.day === today ? "today" : ""}`}
                title={c.secs ? t("rh.dayTitle", { day: fmtDate(new Date(`${c.day}T00:00:00`), { month: "long", day: "numeric" }), time: fmtSecs(c.secs) }) : t("rh.dayNone", { day: fmtDate(new Date(`${c.day}T00:00:00`), { month: "long", day: "numeric" }) })}
              />
            ),
          )}
        </div>
        <div className="rheat-legend">
          {t("rh.less")}
          {legend.map((l) => (
            <i key={l} className={l ? `l${l}` : ""} />
          ))}
          {t("rh.more")}
        </div>
      </div>
    </div>
  );
}
