import { useMemo } from "react";
import { fmtDate, t } from "../i18n";
import { todayStr } from "../tasks/date";
import { useReading } from "./store";
import { bookStat, fmtSecs } from "./stats";
import "./reading.css";

/** Time spent on one book: total, days, pace, the last two weeks, and when it will probably be finished. */
export function ReadingStats({ bookId, progress, enabled }: { bookId: string; progress: number; enabled: boolean }) {
  const rows = useReading();
  const today = todayStr();
  const s = useMemo(() => bookStat(rows, bookId, progress, today), [rows, bookId, progress, today]);
  if (!enabled) return <p className="hint">{t("rs.off")}</p>;
  const top = Math.max(1, ...s.recent.map((r) => r.mins));
  return (
    <div className="rstats">
      <h4>{t("rs.title")}</h4>
      <div className="kpis">
        <div>
          <b>{fmtSecs(s.secs)}</b>
          <span>{t("rs.total")}</span>
        </div>
        <div>
          <b>{s.days}</b>
          <span>{t("rs.days")}</span>
        </div>
        {s.speed !== null && (
          <div>
            <b>{t("rs.speedVal", { p: s.speed.toFixed(1) })}</b>
            <span>{t("rs.speed")}</span>
          </div>
        )}
      </div>
      <div className="spark" title={t("rs.recent")}>
        {s.recent.map((r, i) => (
          <i key={r.day} className={i === s.recent.length - 1 ? "today" : ""} style={{ height: `${r.mins ? Math.max(8, (r.mins / top) * 100) : 0}%` }} title={`${r.day} · ${fmtSecs(r.mins * 60)}`} />
        ))}
      </div>
      <p className="hint">{s.eta ? t("rs.eta", { date: fmtDate(new Date(`${s.eta}T00:00:00`), { month: "long", day: "numeric" }) }) : t("rs.few")}</p>
    </div>
  );
}
