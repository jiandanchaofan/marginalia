import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import type { Goal, Task } from "../core/types";
import { planOf, shiftPlan, todayStr } from "../tasks/date";
import type { Link } from "../tasks/goalStore";
import { PACE_TEXT, STATUS_NAME, elapsed, goalLabel, goalsIn, paceOf, progressOfGoal, supportMap, toReview } from "../tasks/goals";
import { ReviewBar } from "./Goals";
import { beginTaskDrag } from "../tasks/taskDrag";
import { GoalDialog } from "./GoalDialog";
import { PlanChip } from "./TaskRow";
import { monthName, shortDay, t as tr } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

const SHOW = 5;

export interface PageProps {
  goals: Goal[];
  links: Link[];
  tasks: Task[];
  notify(msg: string): void;
  onToggleTask(t: Task, done: boolean): void;
  /** Open the todo's detail panel. */
  onOpenTask(t: Task): void;
}

type Editing = Goal | { kind: Goal["kind"]; period: string } | null;

function Stepper({ label, onPrev, onNext, onNow, now }: { label: string; onPrev(): void; onNext(): void; onNow(): void; now: boolean }) {
  return (
    <span className="period-nav">
      <button title={tr("gp.prev")} onClick={onPrev}>
        <ChevronLeft size={14} />
      </button>
      <b>{label}</b>
      <button title={tr("gp.next")} onClick={onNext}>
        <ChevronRight size={14} />
      </button>
      {!now && (
        <button className="period-now" onClick={onNow}>
          {tr("gp.now")}
        </button>
      )}
    </span>
  );
}

const PRI = (n: number) => (n > 0 ? tr(`todo.pri${n}` as Key) : "");

/** One todo as a row: tick box, title (click to open it) and its state: planned for, deadline, priority. */
function TodoLine({ t, today, onToggle, onOpen, loose }: { t: Task; today: string; onToggle(t: Task, done: boolean): void; onOpen(t: Task): void; loose?: boolean }) {
  const late = !t.done && !!t.deadline && t.deadline < today;
  return (
    <div
      className={`goal-todo ${loose ? "loose" : ""}`}
      onPointerDown={(e) => beginTaskDrag(e, t)}
    >
      <input type="checkbox" className={`task-box p${t.priority}`} checked={t.done} onChange={(e) => onToggle(t, e.target.checked)} title={t.done ? tr("row.markUndone") : tr("row.markDone")} />
      <button className={`goal-todo-t ${t.done ? "done" : ""}`} onClick={() => onOpen(t)} title={tr("gp.openTip")}>
        {t.title}
      </button>
      <span className="goal-todo-state">
        {t.done && <span className="todo-chip done">{tr("gp.done")}</span>}
        <PlanChip task={t} today={today} />
        {t.deadline && <span className={`todo-chip due ${late ? "late" : ""}`}>{tr("todo.due", { date: shortDay(t.deadline) })}</span>}
        {t.priority > 0 && <span className={`todo-chip pri p${t.priority}`}>{PRI(t.priority)}</span>}
      </span>
    </div>
  );
}

function Card({ g, goals, support, todos, stamp, onEdit, onToggleTask, onOpenTask }: { g: Goal; goals: Goal[]; support: Map<string, Task[]>; todos?: boolean; /** red stamp on the right: a goal carried over from an earlier month */ stamp?: string; onEdit(g: Goal): void; onToggleTask(t: Task, done: boolean): void; onOpenTask(t: Task): void }) {
  const today = todayStr();
  const pr = progressOfGoal(g, support);
  const pace = paceOf(g, pr, today);
  const parent = g.parentId ? goals.find((x) => x.id === g.parentId) : null;
  const kids = goals.filter((x) => x.parentId === g.id).sort((a, b) => (a.period < b.period ? 1 : -1));
  const el = elapsed(g, today);
  const mine = support.get(g.id) ?? [];
  const sorted = useMemo(() => [...mine].sort((a, b) => Number(a.done) - Number(b.done)), [mine]);
  const [open, setOpen] = useState(false);
  const late = !stamp && (pace === "late" || pace === "over");
  return (
    <div className={`goal-card ${stamp ? "stamped" : ""} ${late ? "late" : ""} ${g.status !== "doing" ? "closed" : ""}`} data-drop={`goal:${g.id}`} title={tr("gp.dropTip")}>
      {stamp && <span className="goal-stamp" title={tr("gp.stampTip")}>{stamp}</span>}
      <div className="goal-top">
        <span className="goal-name">{g.title}</span>
        <button className="icon-btn goal-edit" title={tr("gp.edit")} onClick={() => onEdit(g)}>
          <Pencil size={13} />
        </button>
      </div>
      <div className="goal-bar">
        <i className={late ? "late" : ""} style={{ width: `${pr.percent}%` }} />
        {g.status === "doing" && el > 0 && el < 1 && <b style={{ left: `${el * 100}%` }} title={tr("gp.elapsed", { pct: Math.round(el * 100) })} />}
      </div>
      <div className="goal-meta">
        <span className="goal-pct">{pr.percent}%</span>
        <span>{pr.mode === "auto" ? (pr.total ? tr("gp.todos", { done: pr.done, total: pr.total }) : tr("gp.noTodos")) : tr("gp.manualTodos", { n: mine.length })}</span>
        {g.status !== "doing" ? <span className="chip-st">{STATUS_NAME[g.status]}</span> : !stamp && PACE_TEXT[pace] && <span className={`chip-pace ${pace}`}>{PACE_TEXT[pace]}</span>}
        {parent && <span className="goal-parent">{tr("gp.supports", { title: parent.title })}</span>}
      </div>
      {kids.length > 0 && (
        <div className="goal-kids">
          {kids.map((k) => {
            const kp = progressOfGoal(k, support);
            return (
              <div key={k.id} className="goal-kid">
                <span>
                  {goalLabel(k)}：{k.title}
                </span>
                {k.status === "doing" ? <span>{kp.percent}%</span> : <span className="chip-st">{STATUS_NAME[k.status]}</span>}
              </div>
            );
          })}
        </div>
      )}
      {todos && mine.length > 0 && (
        <div className="goal-todos">
          {sorted.slice(0, open ? undefined : SHOW).map((t) => (
            <TodoLine key={t.id} t={t} today={todayStr()} onToggle={onToggleTask} onOpen={onOpenTask} />
          ))}
          {sorted.length > SHOW && (
            <button className="goal-more" onClick={() => setOpen((v) => !v)}>
              {open ? tr("gp.less") : tr("gp.more", { n: sorted.length - SHOW })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Hd({ title, children, add }: { title: string; children?: React.ReactNode; add?: React.ReactNode }) {
  return (
    <div className="gp-head">
      <h2>{title}</h2>
      {children}
      <span className="nb-spacer" />
      {add}
    </div>
  );
}

/** 年度目标: the goals of one year, how far along each is, and the month goals under them. */
export function YearPage({ goals, links, tasks, notify, onToggleTask, onOpenTask }: PageProps) {
  const today = todayStr();
  const [off, setOff] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const year = shiftPlan(planOf("year", today), off);
  const support = useMemo(() => supportMap(links, tasks), [links, tasks]);
  const list = goalsIn(goals, "year", year.raw);
  const review = toReview(goals.filter((g) => g.kind === "year"), today);
  return (
    <div className="gp">
      <Hd
        title={tr("gp.yearTitle")}
        add={
          <button className="goal-add" onClick={() => setEditing({ kind: "year", period: year.raw })}>
            <Plus size={13} /> {tr("gp.yearAdd")}
          </button>
        }
      >
        <Stepper label={tr("gp.yearLabel", { y: year.raw })} onPrev={() => setOff(off - 1)} onNext={() => setOff(off + 1)} onNow={() => setOff(0)} now={off === 0} />
      </Hd>
      {review.length > 0 && <ReviewBar review={review} goals={goals} tasksOf={(g) => support.get(g.id) ?? []} notify={notify} />}
      <Summary goals={list} support={support} today={today} start={year.start} end={year.end} what={tr("gp.thisYearWhat")} />
      <div className="gp-cards">
        {list.map((g) => (
          <Card key={g.id} g={g} goals={goals} support={support} todos onEdit={setEditing} onToggleTask={onToggleTask} onOpenTask={onOpenTask} />
        ))}
      </div>
      {!list.length && <div className="goal-empty">{tr("gp.emptyYear")}</div>}
      {editing && <GoalDialog target={editing} goals={goals} links={links} tasks={tasks} onClose={() => setEditing(null)} notify={notify} />}
    </div>
  );
}

/** The numbers at the top of a goal page: a band of its own, apart from the goal cards below it. */
function Summary({ goals, support, today, start, end, what }: { goals: Goal[]; support: Map<string, Task[]>; today: string; start: string; end: string; what: string }) {
  const doing = goals.filter((g) => g.status === "doing");
  const done = goals.filter((g) => g.status === "done").length;
  const late = doing.filter((g) => ["late", "over"].includes(paceOf(g, progressOfGoal(g, support), today))).length;
  const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000 + 1;
  const gone = (new Date(today).getTime() - new Date(start).getTime()) / 86400000 + 1;
  const spent = Math.round(Math.min(1, Math.max(0, gone / days)) * 100);
  const cells: { n: number | string; label: string; warn?: boolean }[] = [
    { n: doing.length, label: tr("gp.sumDoing") },
    { n: done, label: tr("gp.sumDone") },
    { n: late, label: tr("gp.sumLate"), warn: late > 0 },
  ];
  return (
    <div className="gp-summary">
      {cells.map((c) => (
        <div key={c.label} className="gp-sum-cell">
          <b className={c.warn ? "warn" : ""}>{c.n}</b>
          <span>{c.label}</span>
        </div>
      ))}
      <div className="gp-sum-cell time">
        <span>
          {tr("gp.spent", { what })} <b>{spent}%</b>
        </span>
        <i className="gp-sum-bar">
          <u style={{ width: `${spent}%` }} />
        </i>
      </div>
    </div>
  );
}

/** 月度目标: one month's goals with their todos, and the todos of that month that support no goal. */
export function MonthPage({ goals, links, tasks, notify, onToggleTask, onOpenTask }: PageProps) {
  const today = todayStr();
  const [off, setOff] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const month = shiftPlan(planOf("month", today), off);
  const support = useMemo(() => supportMap(links, tasks), [links, tasks]);
  const list = goalsIn(goals, "month", month.raw);
  // month goals that were not finished in an earlier month move on to this month by themselves (this month only)
  const carried = off === 0 ? goals.filter((g) => g.kind === "month" && g.status === "doing" && g.period < month.raw).sort((a, b) => (a.period < b.period ? -1 : 1)) : [];
  const stampOf = (g: Goal) => (g.period.slice(0, 4) === month.start.slice(0, 4) ? tr("gp.stampMonth", { name: monthName(g.period.slice(0, 4), g.period.slice(5, 7)) }) : tr("gp.stampMonth", { name: monthName(g.period.slice(0, 4), g.period.slice(5, 7), true) }));
  const linked = useMemo(() => new Set(links.map((l) => l[0])), [links]);
  const loose = useMemo(
    () =>
      tasks
        .filter((t) => !t.done && !linked.has(t.id))
        .filter((t) => (t.planStart && t.planStart <= month.end && t.planEnd >= month.start) || (!!t.deadline && t.deadline >= month.start && t.deadline <= month.end))
        .sort((a, b) => (a.planStart || "9") < (b.planStart || "9") ? -1 : 1),
    [tasks, linked, month.start, month.end],
  );
  const label = tr("gd.month", { name: monthName(month.start.slice(0, 4), month.start.slice(5, 7), true) });
  return (
    <div className="gp">
      <Hd
        title={off === 0 ? tr("gp.monthTitleNow") : tr("gp.monthTitle")}
        add={
          <button className="goal-add" onClick={() => setEditing({ kind: "month", period: month.raw })}>
            <Plus size={13} /> {tr("gp.monthAdd")}
          </button>
        }
      >
        <Stepper label={label} onPrev={() => setOff(off - 1)} onNext={() => setOff(off + 1)} onNow={() => setOff(0)} now={off === 0} />
      </Hd>
      <Summary goals={[...carried, ...list]} support={support} today={today} start={month.start} end={month.end} what={tr("gp.thisMonthWhat")} />
      <div className="gp-cards">
        {carried.map((g) => (
          <Card key={g.id} g={g} goals={goals} support={support} todos stamp={stampOf(g)} onEdit={setEditing} onToggleTask={onToggleTask} onOpenTask={onOpenTask} />
        ))}
        {list.map((g) => (
          <Card key={g.id} g={g} goals={goals} support={support} todos onEdit={setEditing} onToggleTask={onToggleTask} onOpenTask={onOpenTask} />
        ))}
      </div>
      {!list.length && !carried.length && <div className="goal-empty">{tr("gp.emptyMonth")}</div>}
      {loose.length > 0 && (
        <div className="gp-loose">
          <div className="gp-sec">
            <span>{tr("gp.loose", { n: loose.length })}</span>
            <span>{tr("gp.looseHint")}</span>
          </div>
          {loose.map((t) => (
            <TodoLine key={t.id} t={t} today={today} loose onToggle={onToggleTask} onOpen={onOpenTask} />
          ))}
        </div>
      )}
      {editing && <GoalDialog target={editing} goals={goals} links={links} tasks={tasks} onClose={() => setEditing(null)} notify={notify} />}
    </div>
  );
}

type Filter = "all" | "done" | "missed" | "dropped";

/** 归档目标: every goal that has been decided (达成 / 未达成 / 放弃), by year, with a strip of months. */
export function ArchivePage({ goals, links, tasks, notify }: Omit<PageProps, "onToggleTask" | "onOpenTask">) {
  const [filter, setFilter] = useState<Filter>("all");
  const [pick, setPick] = useState<string | null>(null); // "2026-11"
  const [editing, setEditing] = useState<Editing>(null);
  const support = useMemo(() => supportMap(links, tasks), [links, tasks]);
  const archived = goals.filter((g) => g.status !== "doing" && (filter === "all" || g.status === filter));
  const years = useMemo(() => [...new Set(goals.filter((g) => g.status !== "doing").map((g) => g.period.slice(0, 4)))].sort().reverse(), [goals]);
  const now = todayStr();
  return (
    <div className="gp">
      <Hd title={tr("gp.archiveTitle")}>
        {(
          [
            ["all", tr("list.all")],
            ["done", tr("goal.status.done")],
            ["missed", tr("goal.status.missed")],
            ["dropped", tr("goal.status.dropped")],
          ] as [Filter, string][]
        ).map(([k, n]) => (
          <button key={k} className={`goal-add ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
            {n}
          </button>
        ))}
      </Hd>
      {!years.length && <div className="goal-empty">{tr("gp.archiveEmpty")}</div>}
      {years.map((y) => {
        const yearGoals = goals.filter((g) => g.period.slice(0, 4) === y);
        const closed = yearGoals.filter((g) => g.status !== "doing");
        const yg = closed.filter((g) => g.kind === "year");
        const rows = archived.filter((g) => g.period.slice(0, 4) === y && (!pick || pick.slice(0, 4) !== y || g.kind === "year" || g.period === pick));
        return (
          <div key={y} className="gp-year">
            <div className="gp-year-head">
              <b>{tr("gp.yearHead", { y })}</b>
              <span>
                {tr("gp.yearSummary", { n: yg.length, a: yg.filter((g) => g.status === "done").length, b: yg.filter((g) => g.status === "missed").length, c: yg.filter((g) => g.status === "dropped").length })}
              </span>
            </div>
            <div className="gp-months">
              {Array.from({ length: 12 }, (_, i) => {
                const raw = `${y}-${String(i + 1).padStart(2, "0")}`;
                const ms = yearGoals.filter((g) => g.kind === "month" && g.period === raw);
                const cls = !ms.length ? "" : ms.some((g) => g.status === "doing") ? (raw < now.slice(0, 7) ? "w" : "p") : ms.some((g) => g.status === "missed" || g.status === "dropped") ? "w" : "g";
                return (
                  <button key={raw} className={`gp-mo ${cls} ${pick === raw ? "sel" : ""}`} disabled={!ms.length} title={ms.length ? tr("gp.moTip", { name: monthName(y, i + 1), n: ms.length }) : tr("gp.moNone")} onClick={() => setPick(pick === raw ? null : raw)}>
                    {i + 1}
                  </button>
                );
              })}
            </div>
            {rows.map((g) => (
              <button key={g.id} className="gp-row" onClick={() => setEditing(g)}>
                <span className="gp-row-t">
                  {g.kind === "year" ? tr("gp.rowYear") : tr("gp.rowMonth", { name: monthName(g.period.slice(0, 4), g.period.slice(5)) })} · {g.title}
                  <em> {progressOfGoal(g, support).percent}%</em>
                </span>
                <span className={`chip-st st-${g.status}`}>{STATUS_NAME[g.status]}</span>
              </button>
            ))}
            {!rows.length && <div className="goal-empty">{tr("gp.noMatch")}</div>}
          </div>
        );
      })}
      {editing && <GoalDialog target={editing} goals={goals} links={links} tasks={tasks} onClose={() => setEditing(null)} notify={notify} />}
    </div>
  );
}
