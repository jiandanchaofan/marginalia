import { useEffect, useMemo, useRef, useState } from "react";
import { dayKey, notesStore, useNotesVersion, type NoteStats } from "../notes/store";
import { dayLabel } from "../notes/query";
import { t } from "../i18n";

const CELL = 10; // minimum square size; squares stretch to fill the sidebar
const GAP = 3;
const level = (n: number) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);

/** Flomo-style contribution map: one square per day, a column per week (Monday first), newest week on the right. */
export function Heatmap({ selected, onPick }: { selected?: string; onPick(day: string | undefined): void }) {
  const version = useNotesVersion();
  const [stats, setStats] = useState<NoteStats>({ days: {}, total: 0, tags: 0 });
  const [weeks, setWeeks] = useState(17);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    notesStore.stats().then((s) => alive && setStats(s));
    return () => {
      alive = false;
    };
  }, [version]);

  // As many week-columns as fit the sidebar.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWeeks(Math.max(8, Math.min(26, Math.floor((el.clientWidth + GAP) / (CELL + GAP)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const today = new Date();
  const todayKey = dayKey(today);
  const cells = useMemo(() => {
    const wd = (today.getDay() + 6) % 7; // Monday = 0
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - wd - (weeks - 1) * 7);
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = dayKey(d);
      return { key, n: stats.days[key] ?? 0, future: d.getTime() > today.getTime() };
    });
  }, [weeks, stats, todayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeDays = Object.values(stats.days).filter((n) => n > 0).length;

  return (
    <div className="heat">
      <div className="heat-stats">
        <div>
          <b>{stats.total}</b>
          <span>{t("heat.notes")}</span>
        </div>
        <div>
          <b>{stats.tags}</b>
          <span>{t("heat.tags")}</span>
        </div>
        <div>
          <b>{activeDays}</b>
          <span>{t("heat.days")}</span>
        </div>
      </div>
      <div ref={box} className="heat-box">
        <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
          {cells.map((c) =>
            c.future ? (
              <i key={c.key} className="heat-cell blank" />
            ) : (
              <button
                key={c.key}
                className={`heat-cell l${level(c.n)} ${c.key === todayKey ? "today" : ""} ${c.key === selected ? "picked" : ""}`}
                title={c.n ? t("heat.dayTitle", { day: dayLabel(c.key), n: c.n }) : t("heat.dayNone", { day: dayLabel(c.key) })}
                onClick={() => onPick(c.key === selected ? undefined : c.key)}
              />
            ),
          )}
        </div>
      </div>
      <div className="heat-legend">
        <span>{t("heat.less")}</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`heat-cell l${l}`} />
        ))}
        <span>{t("heat.more")}</span>
      </div>
    </div>
  );
}
