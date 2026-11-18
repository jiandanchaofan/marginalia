import { useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUp } from "lucide-react";
import type { Goal, Task } from "../core/types";
import { isUnder } from "../notes/tags";
import { formatPlan, parseTaskPlan, planOf, todayStr } from "../tasks/date";
import { goalsOfMap } from "../tasks/goals";
import { dueDay, loadCfg, quadrantOf, saveCfg, statusOf, type MatrixCfg } from "../tasks/matrix";
import { beginTaskDrag } from "../tasks/taskDrag";
import { t as tr } from "../i18n";
import type { Key } from "../i18n/zh-Hans";
import "./matrix.css";

type Range = "all" | "week" | "month";
const RANGE = "reader:matrix-range";
const loadRange = (): Range => {
  try {
    const v = localStorage.getItem(RANGE);
    return v === "week" || v === "month" ? v : "all";
  } catch {
    return "all";
  }
};

/** How the board is divided: by the number of tasks, or by hand (the share of the width the left column and of the height the top row take). */
type Layout = { auto: true } | { auto: false; cx: number; ry: number };
const LAYOUT = "reader:matrix-layout";
const loadLayout = (): Layout => {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT) ?? "null");
    if (v && v.auto === false && Number.isFinite(v.cx) && Number.isFinite(v.ry)) return { auto: false, cx: clampShare(v.cx), ry: clampShare(v.ry) };
  } catch {
    /* ignore */
  }
  return { auto: true };
};
const MIN_SHARE = 0.18;
const clampShare = (n: number) => Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, n));
/** A box with more tasks gets more room, but an empty one stays big enough to drop a task into. */
const autoShare = (a: number, b: number) => Math.min(0.75, Math.max(0.25, (a + 1.5) / (a + b + 3)));

/** Quadrant order on screen: important on top, urgent on the right. The key is what a drop target carries (see Tasks.moveTo). */
const CELLS: { key: string; important: boolean; urgent: boolean; name: Key; hint: Key; tone: string }[] = [
  { key: "q:iN", tone: "q2", important: true, urgent: false, name: "mx.q2", hint: "mx.q2h" },
  { key: "q:iU", tone: "q1", important: true, urgent: true, name: "mx.q1", hint: "mx.q1h" },
  { key: "q:nN", tone: "q4", important: false, urgent: false, name: "mx.q4", hint: "mx.q4h" },
  { key: "q:nU", tone: "q3", important: false, urgent: true, name: "mx.q3", hint: "mx.q3h" },
];

interface Props {
  tasks: Task[];
  goals: Goal[];
  links: [string, string][];
  selectedId: string | null;
  onOpenTask(t: Task): void;
}

export function MatrixPage({ tasks, goals, links, selectedId, onOpenTask }: Props) {
  const today = todayStr();
  const [cfg, setCfg] = useState<MatrixCfg>(loadCfg);
  const [range, setRange] = useState<Range>(loadRange);
  const [tag, setTag] = useState("");
  const [goal, setGoal] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const boardRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ t: Task; x: number; y: number } | null>(null);
  const goalsOf = useMemo(() => goalsOfMap(links, goals), [links, goals]);
  const tagList = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of tasks) if (!t.done) for (const g of t.tags) n.set(g, (n.get(g) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  }, [tasks]);
  const goalList = useMemo(() => goals.filter((g) => g.status === "doing"), [goals]);

  const change = (c: Partial<MatrixCfg>) => {
    const next = { ...cfg, ...c };
    setCfg(next);
    saveCfg(next);
  };
  const pickRange = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE, r);
    } catch {
      /* storage unavailable */
    }
  };

  const shown = useMemo(() => {
    const end = range === "week" ? planOf("week", today).end : range === "month" ? planOf("month", today).end : "";
    const mine = goal ? new Set(links.filter((l) => l[1] === goal).map((l) => l[0])) : null;
    return tasks.filter((t) => {
      if (t.done && !showDone) return false;
      if (end) {
        const d = dueDay(t);
        if (!d || d > end) return false;
      }
      if (tag && !t.tags.some((x) => isUnder(x, tag))) return false;
      if (mine && !mine.has(t.id)) return false;
      return true;
    });
  }, [tasks, range, tag, goal, showDone, links, today]);

  const cells = CELLS.map((c) => {
    const list = shown
      .filter((t) => {
        const q = quadrantOf(t, today, cfg);
        return q.important === c.important && q.urgent === c.urgent;
      })
      .sort((a, b) => Number(a.done) - Number(b.done) || (dueDay(a) || "9999").localeCompare(dueDay(b) || "9999") || b.priority - a.priority || a.sort - b.sort);
    return { ...c, list };
  });

  // widths and heights of the boxes
  const left = cells[0].list.length + cells[2].list.length;
  const right = cells[1].list.length + cells[3].list.length;
  const top = cells[0].list.length + cells[1].list.length;
  const bottom = cells[2].list.length + cells[3].list.length;
  const cx = layout.auto ? autoShare(left, right) : layout.cx;
  const ry = layout.auto ? autoShare(top, bottom) : layout.ry;
  const setManual = (next: { cx?: number; ry?: number }) => {
    const l: Layout = { auto: false, cx: clampShare(next.cx ?? cx), ry: clampShare(next.ry ?? ry) };
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT, JSON.stringify(l));
    } catch {
      /* storage unavailable */
    }
  };
  const setAuto = () => {
    setLayout({ auto: true });
    try {
      localStorage.removeItem(LAYOUT);
    } catch {
      /* storage unavailable */
    }
  };
  /** Drag a divider: `axis` x moves the vertical line, y the horizontal one, both the crossing. */
  const dragDivider = (axis: "x" | "y" | "xy") => (e: React.PointerEvent) => {
    const el = boardRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setManual({ ...(axis !== "y" ? { cx: (ev.clientX - r.left) / r.width } : {}), ...(axis !== "x" ? { ry: (ev.clientY - r.top) / r.height } : {}) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const status = (t: Task) => {
    const s = statusOf(t, today);
    return { tone: s.tone, text: tr(s.key, { n: s.n ?? 0 }) };
  };
  const planText = (t: Task) => {
    const p = t.plan ? parseTaskPlan(t.plan) : null;
    return p ? formatPlan(p) : "";
  };

  return (
    <div className="mx">
      <div className="mx-filters">
        <label>
          {tr("mx.range")}
          <select value={range} onChange={(e) => pickRange(e.target.value as Range)}>
            <option value="all">{tr("mx.rangeAll")}</option>
            <option value="week">{tr("mx.rangeWeek")}</option>
            <option value="month">{tr("mx.rangeMonth")}</option>
          </select>
        </label>
        <label>
          {tr("mx.tag")}
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">{tr("mx.any")}</option>
            {tagList.map((g) => (
              <option key={g} value={g}>
                #{g}
              </option>
            ))}
          </select>
        </label>
        <label>
          {tr("mx.goal")}
          <select value={goal} onChange={(e) => setGoal(e.target.value)}>
            <option value="">{tr("mx.any")}</option>
            {goalList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
        <button className="mx-chip" aria-pressed={layout.auto} onClick={setAuto} title={tr("mx.autoTip")}>
          {tr("mx.auto")}
        </button>
        <button className="mx-chip" aria-pressed={showDone} onClick={() => setShowDone((v) => !v)}>
          {tr("mx.showDone")}
        </button>
        <span className="mx-sp" />
        <label title={tr("mx.impTip")}>
          {tr("mx.impLine")}
          <select value={cfg.importantFrom} onChange={(e) => change({ importantFrom: e.target.value === "3" ? 3 : 2 })}>
            <option value={2}>{tr("mx.impMid")}</option>
            <option value={3}>{tr("mx.impHigh")}</option>
          </select>
        </label>
        <label title={tr("mx.urgTip")}>
          {tr("mx.urgLine")}
          <input
            className="mx-days"
            type="number"
            min={0}
            max={365}
            value={cfg.urgentDays}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 0 && n <= 365) change({ urgentDays: n });
            }}
            aria-label={tr("mx.urgLine")}
          />
          {tr("mx.days")}
        </label>
      </div>

      <div className="mx-stage">
        <div className="mx-ylab">
          <span>{tr("mx.high")}</span>
          <b>{tr("mx.important")}<ArrowUp size={18} /></b>
          <span>{tr("mx.low")}</span>
        </div>
        <div className="mx-board" ref={boardRef} style={{ "--c1": `${cx}fr`, "--c2": `${1 - cx}fr`, "--r1": `${ry}fr`, "--r2": `${1 - ry}fr`, "--cx": `${cx * 100}%`, "--ry": `${ry * 100}%` } as React.CSSProperties}>
          <i className="mx-div v" onPointerDown={dragDivider("x")} onDoubleClick={setAuto} title={tr("mx.dividerTip")} />
          <i className="mx-div h" onPointerDown={dragDivider("y")} onDoubleClick={setAuto} title={tr("mx.dividerTip")} />
          <i className="mx-div c" onPointerDown={dragDivider("xy")} onDoubleClick={setAuto} title={tr("mx.dividerTip")} />
          {cells.map((c) => (
            <section key={c.key} className={`mx-q ${c.tone}`} data-drop={c.key}>
              <h3>
                {tr(c.name)}
                <small>{tr(c.hint)}</small>
                <span className="mx-n">{c.list.length}</span>
              </h3>
              {c.list.length ? (
                <ul>
                  {c.list.map((t) => {
                    const s = status(t);
                    return (
                      <li
                        key={t.id}
                        className={`${s.tone} ${t.id === selectedId ? "sel" : ""}`}
                        onPointerDown={(e) => beginTaskDrag(e, t)}
                        onClick={() => onOpenTask(t)}
                        onMouseEnter={(e) => setPop({ t, x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => setPop((p) => (p && p.t.id === t.id ? { ...p, x: e.clientX, y: e.clientY } : p))}
                        onMouseLeave={() => setPop(null)}
                      >
                        <span className="mx-dot" />
                        <span className="mx-title">{t.title}</span>
                        <span className="mx-status">{s.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="mx-empty">{tr("mx.empty")}</div>
              )}
            </section>
          ))}
        </div>
        <div />
        <div className="mx-xlab">
          <span>{tr("mx.notUrgent")}</span>
          <b>{tr("mx.urgent")}<ArrowRight size={18} /></b>
          <span>{tr("mx.urgentShort")}</span>
        </div>
      </div>

      {pop && (
        <div className="mx-pop" style={{ left: Math.min(pop.x + 14, window.innerWidth - 280), top: Math.min(pop.y + 14, window.innerHeight - 220) }}>
          <b>{pop.t.title}</b>
          <dl>
            <dt>{tr("mx.p.status")}</dt>
            <dd>{status(pop.t).text}</dd>
            <dt>{tr("mx.p.deadline")}</dt>
            <dd>{pop.t.deadline || "—"}</dd>
            <dt>{tr("mx.p.plan")}</dt>
            <dd>{planText(pop.t) || "—"}</dd>
            <dt>{tr("td.priority")}</dt>
            <dd>{pop.t.priority > 0 ? tr(`todo.pri${pop.t.priority}` as Key) : tr("td.priNone")}</dd>
            <dt>{tr("mx.tag")}</dt>
            <dd>{pop.t.tags.length ? pop.t.tags.map((g) => `#${g}`).join(" ") : "—"}</dd>
            <dt>{tr("mx.goal")}</dt>
            <dd>{(goalsOf.get(pop.t.id) ?? []).map((g) => g.title).join("、") || "—"}</dd>
          </dl>
          {pop.t.note && <p>{pop.t.note.length > 120 ? `${pop.t.note.slice(0, 120)}…` : pop.t.note}</p>}
        </div>
      )}
    </div>
  );
}
