import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarDays, Plus, Trash2, X } from "lucide-react";
import type { Goal, Task } from "../core/types";
import { isFreeNote } from "../core/types";
import type { NoteHit } from "../notes/store";
import { normalizeTag } from "../notes/tags";
import type { Fields } from "../tasks/actions";
import { formatPlan, parseTaskPlan } from "../tasks/date";
import { NoteText } from "./NoteText";
import { PlanPicker } from "./PlanPicker";
import { TagSuggestInput } from "./TagSuggestInput";
import { fmtDateTime, getLang, monthName, shortDay, t as tr } from "../i18n";

const priorities = () => [tr("td.priNone"), tr("todo.pri1"), tr("todo.pri2"), tr("todo.pri3")];
const fmtTime = (ts: number) => fmtDateTime(ts, { month: getLang() === "en" ? "short" : "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

interface Props {
  task: Task;
  kids: Task[];
  /** The note this task came from (read-only preview). */
  hit?: NoteHit;
  sourceName: string;
  /** Goals still in progress, and the ones this todo supports. */
  goals: Goal[];
  goalIds: string[];
  onGoals(ids: string[]): void;
  onUpdate(t: Task, f: Fields): void;
  onDelete(t: Task): void;
  onAddChild(t: Task, title: string): void;
  onSelect(id: string): void;
  onToggleChild(t: Task, done: boolean): void;
  onOpenSource(hit: NoteHit): void;
  onClose(): void;
  /** Increases when the + on a row asks for the subtask box to take the focus. */
  focusChild?: number;
}

const POS_KEY = "reader:task-detail-pos";
const loadPos = (): { x: number; y: number } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
};
const clampPos = (x: number, y: number, w: number) => ({ x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - Math.min(w, 120))), y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 60)) });

/** The floating panel of one task: every field, subtasks, and where it came from. */
export function TaskDetail({ task, kids, hit, sourceName, goals, goalIds, onGoals, onUpdate, onDelete, onAddChild, onSelect, onToggleChild, onOpenSource, onClose, focusChild = 0 }: Props) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note);
  const [tag, setTag] = useState("");
  const [child, setChild] = useState("");
  const [picking, setPicking] = useState(false);
  const childBox = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);
  /** Where the user dragged the panel to (null = docked at the right edge). */
  const [pos, setPos] = useState(loadPos);
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    
    let last = { x: r.left, y: r.top };
    const move = (m: PointerEvent) => {
      last = clampPos(m.clientX - dx, m.clientY - dy, r.width);
      setPos(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(last));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const dock = () => {
    setPos(null);
    try {
      localStorage.removeItem(POS_KEY);
    } catch {
      /* storage unavailable */
    }
  };
  useEffect(() => {
    if (focusChild) childBox.current?.focus();
  }, [focusChild]);
  useEffect(() => {
    setTitle(task.title);
    setNote(task.note);
  }, [task.id, task.title, task.note]);
  const plan = task.plan ? parseTaskPlan(task.plan) : null;
  const inherited = task.tags.filter((t) => !task.ownTags.includes(t));
  const commitTitle = () => {
    const v = title.trim();
    if (!v) return setTitle(task.title);
    if (v !== task.title) onUpdate(task, { title: v });
  };
  const addTag = (raw = tag) => {
    const t = normalizeTag(raw.replace(/^#/, ""));
    setTag("");
    if (t && !task.ownTags.includes(t)) onUpdate(task, { tags: [...task.ownTags, t] });
  };
  return (
    <aside ref={box} className={`task-detail ${pos ? "moved" : ""}`} style={pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", maxHeight: `calc(100vh - ${pos.y}px - 12px)` } : undefined}>
      <div className="td-head" title={tr("td.dragTip")} onPointerDown={startDrag} onDoubleClick={(e) => !(e.target as HTMLElement).closest("button, input, label") && dock()}>
        <label className="td-done">
          <input type="checkbox" className={`task-box p${task.priority}`} checked={task.done} onChange={(e) => onUpdate(task, { done: e.target.checked })} />
          {task.done ? tr("td.done") : tr("td.doing")}
        </label>
        <span className="nb-spacer" />
        <button className="td-icon" title={tr("td.close")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <input
        className="td-title"
        value={title}
        placeholder={tr("td.name")}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
      />
      <textarea className="td-note" rows={3} value={note} placeholder={tr("td.note")} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== task.note && onUpdate(task, { note })} />

      <div className="td-field">
        <span className="td-label">{tr("td.plan")}</span>
        <span className="td-value td-pick">
          <button className="td-btn" onClick={() => setPicking((v) => !v)}>
            <CalendarDays size={13} /> {plan ? formatPlan(plan) : tr("td.unplanned")}
          </button>
          {picking && <PlanPicker value={task.plan} onChange={(raw) => onUpdate(task, { plan: raw })} onClose={() => setPicking(false)} />}
          {plan && plan.kind !== "day" && <em className="td-hint">{shortDay(plan.start)} ~ {shortDay(plan.end)}</em>}
        </span>
      </div>
      <div className="td-field">
        <span className="td-label">{tr("td.deadline")}</span>
        <span className="td-value">
          <input type="date" value={task.deadline} onChange={(e) => onUpdate(task, { deadline: e.target.value })} />
          {task.deadline && (
            <button className="td-icon" title={tr("td.clearDeadline")} onClick={() => onUpdate(task, { deadline: "" })}>
              <X size={13} />
            </button>
          )}
        </span>
      </div>
      <div className="td-field">
        <span className="td-label">{tr("td.priority")}</span>
        <span className="td-value td-seg" role="radiogroup" aria-label={tr("td.priority")}>
          {priorities().map((n, i) => (
            <button key={n} className={`${task.priority === i ? "on" : ""} p${i}`} onClick={() => onUpdate(task, { priority: i })}>
              {n}
            </button>
          ))}
        </span>
      </div>
      <div className="td-field wrap">
        <span className="td-label">{tr("td.tags")}</span>
        <span className="td-value td-tags">
          {task.ownTags.map((t) => (
            <span key={t} className="tag-chip on">
              #{t}
              <button title={tr("td.removeTag")} onClick={() => onUpdate(task, { tags: task.ownTags.filter((x) => x !== t) })}>
                <X size={10} />
              </button>
            </span>
          ))}
          {inherited.map((t) => (
            <span key={t} className="tag-chip inherited" title={tr("td.inheritedTag")}>
              #{t}
            </span>
          ))}
          <TagSuggestInput className="td-taginput" mode="plain" value={tag} placeholder={tr("td.addTag")} onChange={setTag} onEnter={() => addTag()} onPick={(t) => addTag(t)} />
        </span>
      </div>

      {goals.length > 0 && (
        <>
          <div className="td-section">{tr("td.goals")}</div>
          <div className="td-goals">
            {(["year", "month"] as const)
              .map((k) => goals.filter((g) => g.kind === k).sort((x, y) => (x.period < y.period ? 1 : -1)))
              .filter((list) => list.length)
              .map((list, i) => (
                <div key={list[0].kind} className="td-goal-group">
                  {i > 0 && <hr className="td-goal-sep" />}
                  <div className="td-goal-cap">{list[0].kind === "year" ? tr("td.goalYearCap") : tr("td.goalMonthCap")}</div>
                  {list.map((g) => (
                    <label key={g.id} className="td-goal">
                      <input type="checkbox" checked={goalIds.includes(g.id)} onChange={(e) => onGoals(e.target.checked ? [...goalIds, g.id] : goalIds.filter((x) => x !== g.id))} />
                      <span>{g.title}</span>
                      <em>{g.kind === "year" ? g.period : tr("td.goalMonthPeriod", { name: monthName(g.period.slice(0, 4), g.period.slice(5, 7), true) })}</em>
                    </label>
                  ))}
                </div>
              ))}
          </div>
        </>
      )}
      <div className="td-section">{kids.length ? tr("td.subtasksN", { done: kids.filter((k) => k.done).length, total: kids.length }) : tr("td.subtasks")}</div>
      {kids.map((k) => (
        <div key={k.id} className={`td-kid ${k.done ? "done" : ""}`}>
          <input type="checkbox" className={`task-box p${k.priority}`} checked={k.done} onChange={(e) => onToggleChild(k, e.target.checked)} />
          <button className="td-kid-title" onClick={() => onSelect(k.id)}>
            {k.title}
          </button>
          <button className="td-icon danger" title={tr("td.deleteSub")} onClick={() => onDelete(k)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="td-add">
        <Plus size={14} />
        <input
          ref={childBox}
          value={child}
          placeholder={tr("td.addSub")}
          onChange={(e) => setChild(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && child.trim()) {
              onAddChild(task, child);
              setChild("");
            }
          }}
        />
      </div>

      {task.sourceNoteId && (
        <>
          <div className="td-section">{sourceName ? tr("td.fromNoteN", { name: sourceName }) : tr("td.fromNote")}</div>
          {hit ? (
            <div className="td-source">
              {hit.note.anchor.exact && !hit.note.anchor.region && <div className="td-quote">{hit.note.anchor.exact}</div>}
              <NoteText className="nb-note" text={hit.note.note} />
              {!isFreeNote(hit.note) && (
                <button className="td-btn" onClick={() => onOpenSource(hit)}>
                  <ArrowUpRight size={13} /> {tr("td.goText")}
                </button>
              )}
            </div>
          ) : (
            <div className="td-hint">{tr("td.noteGone")}</div>
          )}
        </>
      )}

      <div className="td-foot">
        <span>
          {tr("td.created", { when: fmtTime(task.createdAt) })}
          {task.doneAt ? tr("td.doneAt", { when: fmtTime(task.doneAt) }) : ""}
        </span>
        <span className="nb-spacer" />
        <button className="td-btn danger" onClick={() => onDelete(task)}>
          <Trash2 size={13} /> {tr("td.delete")}
        </button>
      </div>
    </aside>
  );
}
