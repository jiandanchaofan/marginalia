import { useMemo } from "react";
import type { Goal, Task } from "../core/types";
import { addDays, daysBetween, planOf, todayStr } from "../tasks/date";
import { goalsIn, paceOf, progressOfGoal, supportMap } from "../tasks/goals";
import { inList, isOverdue, sortTasks } from "../tasks/query";
import { updateTask } from "../tasks/actions";
import { useGoals } from "../tasks/useGoals";
import { useTasks } from "../tasks/useTasks";
import { fmtDate, shortDay, t } from "../i18n";
import { openInMain } from "../cards/nav";

const GOAL_ROW = 38;
const TODO_ROW = 31;
const HEAD = 24;

function TodoRow({ task, today }: { task: Task; today: string }) {
  const late = isOverdue(task, today);
  return (
    <div className="tc-todo">
      <button className={`tc-box p${task.priority}`} title={t("tc.done")} onClick={() => void updateTask(task, { done: true })} />
      <button className="tc-title" onClick={() => void openInMain({ to: "task", id: task.id })}>
        {task.title}
      </button>
      {late ? (
        <span className="tc-chip red">{t("tc.overdue")}</span>
      ) : task.deadline ? (
        <span className="tc-chip">{t("todo.due", { date: shortDay(task.deadline) })}</span>
      ) : task.priority === 3 ? (
        <span className="tc-chip red">{t("todo.pri3")}</span>
      ) : null}
    </div>
  );
}

function monthElapsed(today: string) {
  const month = planOf("month", today);
  return Math.min(100, Math.max(0, Math.round(((daysBetween(month.start, today) + 1) / (daysBetween(month.start, month.end) + 1)) * 100)));
}

function GoalRow({ goal, support, today }: { goal: Goal; support: Map<string, Task[]>; today: string }) {
  const pr = progressOfGoal(goal, support);
  const pace = paceOf(goal, pr, today);
  const elapsed = monthElapsed(today);
  return (
    <button className="tc-goal" onClick={() => void openInMain({ to: "tasks-month" })}>
      <span className="tc-goal-top">
        <span className="tc-goal-name">{goal.title}</span>
        <b className={pace === "late" ? "late" : ""} title={pace === "late" ? t("tc.late") : undefined}>
          {pr.percent}%
        </b>
      </span>
      <span className="tc-bar">
        <i className={pace === "late" ? "late" : ""} style={{ width: `${pr.percent}%` }} />
        {goal.status === "doing" && <u style={{ left: `${elapsed}%` }} />}
      </span>
    </button>
  );
}

/** Goals of the month, then (as the card grows) today's and tomorrow's to-dos. */
export function TodoCard({ w, h }: { w: number; h: number }) {
  const { goals, links } = useGoals();
  const tasks = useTasks();
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const month = planOf("month", today);
  const support = useMemo(() => supportMap(links, tasks), [links, tasks]);
  const monthGoals = useMemo(() => {
    const carried = goals.filter((g) => g.kind === "month" && g.status === "doing" && g.period < month.raw).sort((a, b) => (a.period < b.period ? -1 : 1));
    return [...carried, ...goalsIn(goals, "month", month.raw)];
  }, [goals, month.raw]);
  const todayList = useMemo(
    () =>
      sortTasks(
        tasks.filter((x) => !x.done && inList(x, "today", today)),
        "priority",
      ),
    [tasks, today],
  );
  const tomorrowList = useMemo(() => tasks.filter((x) => !x.done && ((x.planKind === "day" && x.planStart === tomorrow) || x.deadline === tomorrow)), [tasks, tomorrow]);

  const level = h < 300 ? 1 : h < 480 ? 2 : 3;
  const wide = w >= 520 && level >= 2;
  const avail = Math.max(60, h - 16 - 44 - 26); // card padding, header, body padding

  let goalsN: number;
  let todayN = 0;
  let tomorrowN = 0;
  if (wide) {
    const rows = Math.max(1, Math.floor((avail - HEAD) / TODO_ROW));
    goalsN = Math.max(1, Math.floor((avail - HEAD) / GOAL_ROW));
    todayN = rows;
    tomorrowN = rows;
  } else if (level === 1) {
    goalsN = Math.max(1, Math.floor((avail - HEAD) / GOAL_ROW));
  } else {
    goalsN = Math.min(level === 2 ? 2 : 3, Math.max(1, Math.floor((avail * 0.42 - HEAD) / GOAL_ROW)));
    let room = avail - HEAD - goalsN * GOAL_ROW - HEAD;
    if (level === 3) room -= HEAD;
    const rows = Math.max(1, Math.floor(room / TODO_ROW));
    todayN = level === 2 ? rows : Math.max(1, Math.min(4, rows - 2));
    tomorrowN = level === 3 ? Math.max(1, rows - todayN) : 0;
  }
  const shownGoals = monthGoals.slice(0, goalsN);
  const shownToday = todayList.slice(0, todayN);
  const shownTomorrow = tomorrowList.slice(0, tomorrowN);
  const showsToday = level >= 2;
  const showsTomorrow = level >= 3 || (wide && w >= 700);
  const hiddenGoals = monthGoals.length - shownGoals.length;
  const hiddenTodos = (showsToday ? todayList.length - shownToday.length : 0) + (showsTomorrow ? tomorrowList.length - shownTomorrow.length : 0);

  const goalsBlock = (
    <>
      <div className="tc-sec">
        <span>{t("tc.goals")}</span>
        <em>{t("tc.elapsed", { pct: monthElapsed(today) })}</em>
      </div>
      {shownGoals.length ? shownGoals.map((g) => <GoalRow key={g.id} goal={g} support={support} today={today} />) : <div className="tc-empty">{t("tc.noGoals")}</div>}
    </>
  );
  const todayBlock = (
    <>
      <div className="tc-sec now">
        <span>{t("tc.today")}</span>
        <em>{t("tc.items", { n: todayList.length })}</em>
      </div>
      {shownToday.length ? shownToday.map((x) => <TodoRow key={x.id} task={x} today={today} />) : <div className="tc-empty">{t("tc.nothingToday")}</div>}
    </>
  );
  const tomorrowBlock = (
    <>
      <div className="tc-sec">
        <span>
          {t("tc.tomorrow")} · {fmtDate(new Date(`${tomorrow}T00:00:00`), { weekday: "short" })}
        </span>
        <em>{t("tc.items", { n: tomorrowList.length })}</em>
      </div>
      {shownTomorrow.length ? shownTomorrow.map((x) => <TodoRow key={x.id} task={x} today={today} />) : <div className="tc-empty">{t("tc.nothingTomorrow")}</div>}
    </>
  );

  return (
    <div className={`tc tc-${level} ${wide ? "wide" : ""}`}>
      {wide ? (
        <div className="tc-cols">
          <div className="tc-col">{goalsBlock}</div>
          <div className="tc-col">{todayBlock}</div>
          {showsTomorrow && <div className="tc-col">{tomorrowBlock}</div>}
        </div>
      ) : (
        <div className="tc-stack">
          {goalsBlock}
          {showsToday && todayBlock}
          {showsTomorrow && tomorrowBlock}
        </div>
      )}
      {(hiddenGoals > 0 || hiddenTodos > 0) && (
        <button className="tc-more" onClick={() => void openInMain(level === 1 ? { to: "tasks-month" } : { to: "tasks-list", list: "today" })}>
          <span>{hiddenTodos > 0 ? t("tc.more", { n: hiddenTodos }) : t("tc.moreGoals", { n: hiddenGoals })}</span>
          <span>{t("tc.open")}</span>
        </button>
      )}
    </div>
  );
}
