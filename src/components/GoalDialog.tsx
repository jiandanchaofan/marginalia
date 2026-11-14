import { useMemo, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import type { Goal, Task } from "../core/types";
import { createGoal, deleteGoal, linkTasks, unlinkTasks, updateGoal } from "../tasks/goalActions";
import type { Link } from "../tasks/goalStore";
import { STATUS_NAME } from "../tasks/goals";
import { formatPlan, parseTaskPlan } from "../tasks/date";
import { monthName, t as tr } from "../i18n";

const PAGE = 10;
type Target = Goal | { kind: Goal["kind"]; period: string };

/** Create or edit a goal: what it is, how its progress is measured, and which todos support it (a checklist). */
export function GoalDialog({ target, goals, links, tasks, onClose, notify }: { target: Target; goals: Goal[]; links: Link[]; tasks: Task[]; onClose(): void; notify(msg: string): void }) {
  const existing = "id" in target ? target : null;
  const [kind, setKind] = useState<Goal["kind"]>(target.kind);
  const [period, setPeriod] = useState(target.period);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [parentId, setParentId] = useState<string | null>(existing?.parentId ?? null);
  const [mode, setMode] = useState<Goal["mode"]>(existing?.mode ?? "auto");
  const [percent, setPercent] = useState(existing?.percent ?? 0);
  // todos ticked while creating a new goal are linked when it is saved; for an existing goal a tick links at once
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);

  const mineIds = useMemo(() => new Set(existing ? links.filter((l) => l[1] === existing.id).map((l) => l[0]) : picked), [links, existing, picked]);
  const year = period.slice(0, 4);
  const yearGoals = goals.filter((g) => g.kind === "year" && g.period === year);
  const monthValue = kind === "month" ? period : `${period.slice(0, 4)}-01`;
  const manual = kind === "year" || mode === "manual";

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks
      .filter((t) => mineIds.has(t.id) || !t.done)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle))
      .sort((a, b) => Number(mineIds.has(b.id)) - Number(mineIds.has(a.id)) || (a.planStart || "9999").localeCompare(b.planStart || "9999") || a.createdAt - b.createdAt);
  }, [tasks, mineIds, q]);
  const visible = rows.slice(0, shown);

  const toggle = (t: Task, on: boolean) => {
    if (existing) void (on ? linkTasks(existing.id, [t.id]) : unlinkTasks(existing.id, [t.id])).catch((e) => notify(tr("gd.opFail", { err: String(e) })));
    else
      setPicked((s) => {
        const n = new Set(s);
        if (on) n.add(t.id);
        else n.delete(t.id);
        return n;
      });
  };

  const save = async (status?: Goal["status"]) => {
    const t = title.trim();
    if (!t) return;
    try {
      if (existing) await updateGoal(existing, { title: t, note, kind, period, parentId, mode, percent, ...(status ? { status } : {}) });
      else {
        const g = await createGoal({ title: t, kind, period, parentId, mode, percent, note });
        if (picked.size) await linkTasks(g.id, [...picked]);
      }
      onClose();
    } catch (e) {
      notify(tr("gd.saveFail", { err: String(e) }));
    }
  };

  const periodText = kind === "year" ? tr("gd.year", { y: period }) : period.length >= 7 ? tr("gd.month", { name: monthName(period.slice(0, 4), period.slice(5, 7), true) }) : period.slice(0, 4);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal gd" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="gd-top">
          <span className={`gd-kind ${kind}`}>{kind === "year" ? tr("gd.kindYear") : tr("gd.kindMonth")}</span>
          <span className="gd-period">{periodText}</span>
          {existing && existing.status !== "doing" && <span className={`chip-st st-${existing.status}`}>{STATUS_NAME[existing.status]}</span>}
          <span className="nb-spacer" />
          <button className="icon-btn" onClick={onClose} title={tr("gd.close")}>
            <X size={18} />
          </button>
        </div>

        <input className="gd-title" autoFocus value={title} placeholder={kind === "year" ? tr("gd.titleYear") : tr("gd.titleMonth")} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && !existing && void save()} />

        <div className="gd-grid">
          <span className="gd-label">{tr("gd.period")}</span>
          <div className="gd-ctl">
            <span className="gd-seg">
              <button className={kind === "year" ? "on" : ""} onClick={() => (setKind("year"), setPeriod(period.slice(0, 4)))}>
                {tr("gd.segYear")}
              </button>
              <button className={kind === "month" ? "on" : ""} onClick={() => (setKind("month"), setPeriod(period.length === 4 ? `${period}-${String(new Date().getMonth() + 1).padStart(2, "0")}` : period))}>
                {tr("gd.segMonth")}
              </button>
            </span>
            {kind === "year" ? <input className="gd-input" type="number" min={2000} max={2100} value={period} onChange={(e) => setPeriod(e.target.value)} /> : <input className="gd-input" type="month" value={monthValue} onChange={(e) => e.target.value && setPeriod(e.target.value)} />}
          </div>

          {kind === "month" && (
            <>
              <span className="gd-label">{tr("gd.parent")}</span>
              <div className="gd-ctl">
                <select className="gd-input wide" value={parentId ?? ""} onChange={(e) => setParentId(e.target.value || null)}>
                  <option value="">{tr("gd.noParent")}</option>
                  {yearGoals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <span className="gd-label">{tr("gd.progress")}</span>
          <div className="gd-ctl col">
            {kind === "month" && (
              <span className="gd-seg">
                <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")} title={tr("gd.autoTip")}>
                  {tr("gd.auto")}
                </button>
                <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
                  {tr("gd.manual")}
                </button>
              </span>
            )}
            {manual ? (
              <div className="gd-range">
                <input type="range" min={0} max={100} step={5} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
                <span className="gd-pct">
                  <input type="number" min={0} max={100} value={percent} onChange={(e) => setPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />%
                </span>
              </div>
            ) : (
              <span className="gd-hint">{tr("gd.autoHint")}</span>
            )}
          </div>

          <span className="gd-label">{tr("gd.note")}</span>
          <div className="gd-ctl">
            <textarea className="gd-input wide" rows={2} value={note} placeholder={tr("gd.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <div className="gd-todos">
          <div className="gd-todos-head">
            <b>{tr("gd.todos")}</b>
            <span className="gd-count">{tr("gd.picked", { n: mineIds.size })}</span>
            <label className="gd-search">
              <Search size={12} />
              <input value={q} placeholder={tr("gd.search")} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} />
            </label>
          </div>
          <div className="gd-list">
            {visible.map((t) => {
              const plan = t.plan ? parseTaskPlan(t.plan) : null;
              return (
                <label key={t.id} className={`gd-item ${mineIds.has(t.id) ? "on" : ""}`}>
                  <input type="checkbox" checked={mineIds.has(t.id)} onChange={(e) => toggle(t, e.target.checked)} />
                  <span className={`gd-item-t ${t.done ? "done" : ""}`}>{t.title}</span>
                  {plan && <span className="gd-item-plan">{formatPlan(plan)}</span>}
                </label>
              );
            })}
            {!rows.length && <div className="gd-empty">{q ? tr("gd.noMatch") : tr("gd.noTodos")}</div>}
          </div>
          {rows.length > shown && (
            <button className="gd-more" onClick={() => setShown(shown + PAGE)}>
              {tr("gd.showMore", { n: Math.min(PAGE, rows.length - shown), total: rows.length })}
            </button>
          )}
        </div>

        <div className="gd-foot">
          {existing && (
            <button
              className="gd-btn danger"
              title={tr("gd.deleteTip")}
              onClick={async () => {
                await deleteGoal(existing);
                onClose();
              }}
            >
              <Trash2 size={13} /> {tr("gd.delete")}
            </button>
          )}
          {existing && existing.status === "doing" && (
            <>
              <button className="gd-btn" onClick={() => void save("done")}>
                {tr("gd.markDone")}
              </button>
              <button className="gd-btn" onClick={() => void save("dropped")}>
                {tr("gd.drop")}
              </button>
            </>
          )}
          {existing && existing.status !== "doing" && (
            <button className="gd-btn" onClick={() => void save("doing")}>
              {tr("gd.reopen")}
            </button>
          )}
          <span className="nb-spacer" />
          <button className="gd-btn" onClick={onClose}>
            {tr("gd.cancel")}
          </button>
          <button className="gd-btn primary" disabled={!title.trim()} onClick={() => void save()}>
            {tr("gd.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
