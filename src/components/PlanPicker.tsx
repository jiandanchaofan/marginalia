import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { addDays, formatPlan, isoWeekOf, parseTaskPlan, planOf, todayStr, weekStart } from "../tasks/date";
import { getLang, monthName, shortDay, t as tr } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

const WEEKDAY = () => [1, 2, 3, 4, 5, 6, 7].map((n) => tr(`pp.dow${n}` as Key));
const p2 = (n: number) => String(n).padStart(2, "0");

/** The weeks (Monday first) that cover a month, each with its ISO week number and seven days. */
function monthGrid(year: number, month: number) {
  const first = `${year}-${p2(month)}-01`;
  const { year: wy, week } = isoWeekOf(first);
  let start = weekStart(wy, week);
  const rows: { raw: string; week: number; days: string[] }[] = [];
  do {
    const { year: y2, week: w2 } = isoWeekOf(start);
    rows.push({ raw: `${y2}-W${p2(w2)}`, week: w2, days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) });
    start = addDays(start, 7);
  } while (Number(start.slice(5, 7)) === month && Number(start.slice(0, 4)) === year);
  return rows;
}

/**
 * Choose when a todo is planned: a day or a week. Quick buttons for the usual ones, and a month calendar:
 * click a date for that day, click the week number on the left for the whole week.
 * `value` / `onChange` use the written form (`2026-11-20`, `2026-W47`).
 */
export function PlanPicker({ value, onChange, onClose, title }: { value: string; onChange(raw: string): void; onClose(): void; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const today = todayStr();
  const current = value ? parseTaskPlan(value) : null;
  const [cursor, setCursor] = useState(() => {
    const base = current?.start ?? today;
    return { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) };
  });
  // Fixed position next to the button that opened it, kept inside the window (the detail panel scrolls and would clip it).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
      let top = a.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [cursor.m, cursor.y]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const pick = (raw: string) => {
    onChange(raw);
    onClose();
  };
  const rows = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor.y, cursor.m]);
  const step = (d: number) =>
    setCursor(({ y, m }) => {
      const n = y * 12 + (m - 1) + d;
      return { y: Math.floor(n / 12), m: (n % 12) + 1 };
    });
  const quick = [
    { label: tr("date.today"), raw: planOf("day", today).raw, hint: dayHint(today) },
    { label: tr("date.tomorrow"), raw: planOf("day", addDays(today, 1)).raw, hint: dayHint(addDays(today, 1)) },
    { label: tr("date.thisWeek"), raw: planOf("week", today).raw, hint: weekHint(today) },
    { label: tr("date.nextWeek"), raw: planOf("week", addDays(today, 7)).raw, hint: weekHint(addDays(today, 7)) },
  ];
  return (
    <div className="plan-picker" ref={ref} style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="pp-head">
        <b>{title ?? tr("pp.title")}</b>
        <span className="pp-now">{current ? formatPlan(current) : tr("pp.unplanned")}</span>
        <button className="pp-x" title={tr("pp.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="pp-quick">
        {quick.map((q) => (
          <button key={q.label} className={value === q.raw ? "on" : ""} onClick={() => pick(q.raw)}>
            <span>{q.label}</span>
            <em>{q.hint}</em>
          </button>
        ))}
      </div>

      <div className="pp-cal">
        <div className="pp-cal-nav">
          <button title={tr("pp.prevMonth")} onClick={() => step(-1)}>
            <ChevronLeft size={15} />
          </button>
          <span>
            {tr("pp.monthTitle", { name: monthName(cursor.y, cursor.m, true) })}
          </span>
          <button title={tr("pp.nextMonth")} onClick={() => step(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="pp-grid">
          <span className="pp-dow wk">{tr("pp.weekCol")}</span>
          {WEEKDAY().map((d) => (
            <span key={d} className="pp-dow">
              {d}
            </span>
          ))}
          {rows.map((r) => (
            <div key={r.raw} className={`pp-week ${current?.raw === r.raw ? "sel" : ""}`}>
              <button className="pp-wk" title={tr("pp.weekTip", { n: r.week })} onClick={() => pick(r.raw)}>
                {r.week}
              </button>
              {r.days.map((d) => (
                <button key={d} className={`pp-day ${Number(d.slice(5, 7)) !== cursor.m ? "other" : ""} ${d === today ? "today" : ""} ${current?.raw === d ? "sel" : ""}`} onClick={() => pick(d)}>
                  {Number(d.slice(8))}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="pp-tip">{tr("pp.tip")}</div>
      </div>

      {value && (
        <button className="pp-clear" onClick={() => pick("")}>
          {tr("pp.clear")}
        </button>
      )}
    </div>
  );
}

function dayHint(day: string) {
  return `${tr(`pp.day${new Date(`${day}T00:00:00`).getDay()}` as Key)} ${getLang() === "en" ? shortDay(day) : `${Number(day.slice(5, 7))}-${Number(day.slice(8))}`}`;
}
function weekHint(day: string) {
  return tr("pp.weekHint", { n: isoWeekOf(day).week });
}
