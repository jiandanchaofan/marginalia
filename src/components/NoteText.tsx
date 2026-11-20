import { Fragment } from "react";
import { Tex } from "./Math";
import { findRefs } from "../host/registry";
import { openRef } from "../host/RefPreview";
import { segments } from "../notes/tags";
import { parseBlocks, parseInline, type Inline, type TodoItem } from "../notes/format";
import { splitTodoTokens } from "../tasks/parse";
import { formatPlan, parsePlan, planPassed, todayStr } from "../tasks/date";
import { shortDay, t as tr } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

/** Wrap occurrences of search terms in <mark>. */
export function Marked({ text, terms }: { text: string; terms?: string[] }) {
  const ts = (terms ?? []).map((t) => t.trim()).filter(Boolean);
  if (!ts.length) return <>{text}</>;
  const re = new RegExp(`(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="hit">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

interface Ctx {
  terms?: string[];
  activeTags?: string[];
  onTag?(tag: string): void;
}

/** Text with the references of modules ("约 3:16") marked: a dotted underline, and a click opens the place. */
function WithRefs({ text, terms }: { text: string; terms?: string[] }) {
  const found = findRefs(text);
  if (!found.length) return <Marked text={text} terms={terms} />;
  const parts: React.ReactNode[] = [];
  let at = 0;
  found.forEach((m, i) => {
    if (m.start < at) return;
    if (m.start > at) parts.push(<Marked key={`t${i}`} text={text.slice(at, m.start)} terms={terms} />);
    parts.push(
      <span key={`r${i}`} className="ref-link" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), openRef(m.label))}>
        {text.slice(m.start, m.end)}
      </span>,
    );
    at = m.end;
  });
  if (at < text.length) parts.push(<Marked key="tail" text={text.slice(at)} terms={terms} />);
  return <>{parts}</>;
}

/** Plain text leaf: `#tags` become clickable chips, search terms are highlighted. */
function Leaf({ text, ctx }: { text: string; ctx: Ctx }) {
  return (
    <>
      {segments(text).map((s, i) =>
        s.kind === "tag" ? (
          <button
            key={i}
            className={`tag-chip ${ctx.activeTags?.includes(s.tag) ? "on" : ""}`}
            title={tr("text.filterTag", { tag: s.tag })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              ctx.onTag?.(s.tag);
            }}
          >
            #{s.tag}
          </button>
        ) : (
          <WithRefs key={i} text={s.value} terms={ctx.terms} />
        ),
      )}
    </>
  );
}

function Inlines({ nodes, ctx }: { nodes: Inline[]; ctx: Ctx }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "text") return <Leaf key={i} text={n.v} ctx={ctx} />;
        if (n.t === "math") return <Tex key={i} tex={n.v} />;
        const kids = <Inlines nodes={n.c} ctx={ctx} />;
        return n.t === "b" ? <strong key={i}>{kids}</strong> : n.t === "i" ? <em key={i}>{kids}</em> : n.t === "u" ? <u key={i}>{kids}</u> : <s key={i}>{kids}</s>;
      })}
    </>
  );
}

const priorityName = (n: number) => (n > 0 ? tr(`todo.pri${n}` as Key) : "");

/** One todo line: a real checkbox, the words, and the plan / deadline / priority as small chips. */
function Todo({ item, ctx, onToggle }: { item: TodoItem; ctx: Ctx; onToggle?(line: number): void }) {
  const t = splitTodoTokens(item.text);
  const plan = t.plan ? parsePlan(t.plan) : null;
  const today = todayStr();
  const planLate = !item.done && plan && planPassed(plan, today);
  const dueLate = !item.done && t.deadline && t.deadline < today;
  return (
    <li className={`note-todo ${item.done ? "done" : ""}`} style={item.indent ? { marginLeft: item.indent * 20 } : undefined}>
      <input
        type="checkbox"
        className={`todo-box p${t.priority}`}
        checked={item.done}
        disabled={!onToggle}
        title={onToggle ? (item.done ? tr("todo.markUndone") : tr("todo.markDone")) : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle?.(item.line)}
      />
      <span className="todo-text">
        <Inlines nodes={parseInline(t.rest)} ctx={ctx} />
      </span>
      {plan && (
        <span className={`todo-chip plan ${plan.kind} ${planLate ? "late" : ""}`} title={tr("todo.planTip", { plan: plan.raw })}>
          {formatPlan(plan)}
        </span>
      )}
      {t.deadline && (
        <span className={`todo-chip due ${dueLate ? "late" : ""}`} title={tr("todo.dueTip", { date: t.deadline })}>
          {tr("todo.due", { date: shortDay(t.deadline) })}
        </span>
      )}
      {t.priority > 0 && <span className={`todo-chip pri p${t.priority}`}>{priorityName(t.priority)}</span>}
    </li>
  );
}

/** Note text: light formatting (bold / italic / underline / strikethrough / lists) plus `#tags` as clickable chips. */
export function NoteText({
  text,
  terms,
  activeTags,
  onTag,
  onToggle,
  className = "note-text",
}: {
  text: string;
  terms?: string[];
  activeTags?: string[];
  onTag?(tag: string): void;
  /** Clicking a todo's checkbox: gets the line number in the note. Omit to show the checkboxes read-only. */
  onToggle?(line: number): void;
  className?: string;
}) {
  const ctx: Ctx = { terms, activeTags, onTag };
  return (
    <div className={className}>
      {parseBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <Inlines key={i} nodes={parseInline(b.text)} ctx={ctx} />
        ) : b.kind === "math" ? (
          <Tex key={i} tex={b.tex} display />
        ) : b.kind === "todo" ? (
          <ul key={i} className="note-todos">
            {b.items.map((it) => (
              <Todo key={it.line} item={it} ctx={ctx} onToggle={onToggle} />
            ))}
          </ul>
        ) : b.kind === "ul" ? (
          <ul key={i} className="note-list">
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines nodes={parseInline(it)} ctx={ctx} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="note-list" start={b.start}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines nodes={parseInline(it)} ctx={ctx} />
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
