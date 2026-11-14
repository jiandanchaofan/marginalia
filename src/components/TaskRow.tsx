import { useState } from "react";
import { CalendarDays, ChevronRight, FileText, Plus, Target, Trash2 } from "lucide-react";
import type { Goal, Task } from "../core/types";
import { formatPlan, parseTaskPlan, planPassed, todayStr } from "../tasks/date";
import { progressOf } from "../tasks/query";
import { PlanPicker } from "./PlanPicker";
import { ReflectBox } from "./ReflectBox";
import { beginTaskDrag } from "../tasks/taskDrag";
import { shortDay, t as tr } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

export interface RowCtx {
  kids: Map<string, Task[]>;
  collapsed: Set<string>;
  selectedId: string | null;
  today: string;
  /** Where a task came from (book / article title, or "随手记"), for the small label. */
  sourceName(t: Task): string;
  /** Page and quoted words when the todo was written on a passage, else "". */
  sourceQuote(t: Task): string;
  /** The todo that was just ticked and is being asked what it taught. */
  reflectId: string | null;
  notify(msg: string): void;
  onCloseReflect(): void;
  onSelect(id: string): void;
  onToggleCollapse(id: string): void;
  onDone(t: Task, done: boolean): void;
  onPlan(t: Task, raw: string): void;
  onAddChild(t: Task): void;
  onDelete(t: Task): void;
  onTag(tag: string): void;
  /** Goals this todo supports. */
  goalsOf(t: Task): Goal[];
  onGoal(g: Goal): void;
}

const PRI = (n: number) => (n > 0 ? tr(`todo.pri${n}` as Key) : "");

export function PlanChip({ task, today }: { task: Task; today?: string }) {
  const plan = task.plan ? parseTaskPlan(task.plan) : null;
  if (!plan) return null;
  const late = !task.done && planPassed(plan, today ?? todayStr());
  return (
    <span className={`todo-chip plan ${plan.kind} ${late ? "late" : ""}`} title={tr("todo.planTip", { plan: plan.raw })}>
      {formatPlan(plan)}
    </span>
  );
}

export function TaskRow({ task, depth, ctx }: { task: Task; depth: number; ctx: RowCtx }) {
  const [picking, setPicking] = useState(false);
  const kids = ctx.kids.get(task.id) ?? [];
  const progress = progressOf(task.id, ctx.kids);
  const collapsed = ctx.collapsed.has(task.id);
  const due = task.deadline;
  const dueLate = !task.done && due && due < ctx.today;
  const source = ctx.sourceName(task);
  const quote = ctx.sourceQuote(task);
  const goals = ctx.goalsOf(task);
  return (
    <>
      <div
        className={`task-row ${task.done ? "done" : ""} ${ctx.selectedId === task.id ? "sel" : ""}`}
        style={{ paddingLeft: 8 + depth * 22 }}
        onClick={() => ctx.onSelect(task.id)}
        onPointerDown={(e) => beginTaskDrag(e, task)}
      >
        <button
          className={`task-fold ${kids.length ? "" : "leaf"} ${collapsed ? "" : "open"}`}
          title={collapsed ? tr("row.expand") : tr("row.collapse")}
          onClick={(e) => {
            e.stopPropagation();
            ctx.onToggleCollapse(task.id);
          }}
        >
          {kids.length > 0 && <ChevronRight size={13} />}
        </button>
        <input
          type="checkbox"
          className={`task-box p${task.priority}`}
          checked={task.done}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => ctx.onDone(task, e.target.checked)}
          title={task.done ? tr("row.markUndone") : tr("row.markDone")}
        />
        <div className="task-main">
          <span className="task-title" title={task.title}>{task.title}</span>
          <span className="task-chips">
            <PlanChip task={task} today={ctx.today} />
            {due && (
              <span className={`todo-chip due ${dueLate ? "late" : ""}`} title={tr("todo.dueTip", { date: due })}>
                {tr("todo.due", { date: shortDay(due) })}
              </span>
            )}
            {task.priority > 0 && <span className={`todo-chip pri p${task.priority}`}>{PRI(task.priority)}</span>}
            {goals.length > 0 && (
              <span className={`chip-group of-goals ${goals.length > 1 ? "multi" : ""}`}>
                {goals.map((g) => (
                  <button
                    key={g.id}
                    className="goal-chip"
                    title={tr("row.goalTip", { title: g.title })}
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.onGoal(g);
                    }}
                  >
                    <Target size={10} /> <span className="chip-text">{g.title}</span>
                  </button>
                ))}
                {goals.length > 1 && (
                  <span className="chip-sum goal-chip" title={tr("row.goalsTip", { titles: goals.map((g) => g.title).join(tr("shelf.sep")) })}>
                    <Target size={10} /> {goals.length}
                  </span>
                )}
              </span>
            )}
            {task.tags.length > 0 && (
              <span className={`chip-group of-tags ${task.tags.length > 1 ? "multi" : ""}`}>
                {task.tags.map((tag) => {
                  const cut = tag.lastIndexOf("/") + 1;
                  return (
                    <button
                      key={tag}
                      className="tag-chip"
                      title={tr("text.filterTag", { tag })}
                      onClick={(e) => {
                        e.stopPropagation();
                        ctx.onTag(tag);
                      }}
                    >
                      #{cut > 0 && <span className="tag-pre">{tag.slice(0, cut)}</span>}
                      {tag.slice(cut)}
                    </button>
                  );
                })}
                {task.tags.length > 1 && (
                  <span className="chip-sum tag-chip" title={task.tags.map((t) => `#${t}`).join("　")}>
                    # {task.tags.length}
                  </span>
                )}
              </span>
            )}
            {progress && (
              <span className="task-progress" title={tr("row.progressTip", { total: progress.total, done: progress.done })}>
                {progress.done}/{progress.total}
              </span>
            )}
            {source && (
              <span className="task-source" title={tr("row.fromNote")}>
                <FileText size={11} /> {source}
              </span>
            )}
          </span>
          {quote && (
            <span className="task-quote" title={tr("row.quoteTip")}>
              {quote}
            </span>
          )}
        </div>
        <span className="task-actions" onClick={(e) => e.stopPropagation()}>
          <span className="task-pick">
            <button title={tr("row.plan")} onClick={() => setPicking((v) => !v)}>
              <CalendarDays size={14} />
            </button>
            {picking && <PlanPicker value={task.plan} onChange={(raw) => ctx.onPlan(task, raw)} onClose={() => setPicking(false)} />}
          </span>
          <button title={tr("row.addChild")} onClick={() => ctx.onAddChild(task)}>
            <Plus size={14} />
          </button>
          <button title={tr("card.delete")} className="danger" onClick={() => ctx.onDelete(task)}>
            <Trash2 size={14} />
          </button>
        </span>
      </div>
      {ctx.reflectId === task.id && task.sourceNoteId && (
        <div style={{ paddingLeft: 8 + depth * 22 + 28, paddingRight: 8 }}>
          <ReflectBox title={task.title} noteId={task.sourceNoteId} notify={ctx.notify} onClose={ctx.onCloseReflect} />
        </div>
      )}
      {!collapsed && kids.map((c) => <TaskRow key={c.id} task={c} depth={depth + 1} ctx={ctx} />)}
    </>
  );
}
