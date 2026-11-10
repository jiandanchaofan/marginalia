import { Fragment } from "react";
import { segments } from "../notes/tags";
import { parseBlocks, parseInline, type Inline } from "../notes/format";

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

/** Plain text leaf: `#tags` become clickable chips, search terms are highlighted. */
function Leaf({ text, ctx }: { text: string; ctx: Ctx }) {
  return (
    <>
      {segments(text).map((s, i) =>
        s.kind === "tag" ? (
          <button
            key={i}
            className={`tag-chip ${ctx.activeTags?.includes(s.tag) ? "on" : ""}`}
            title={`筛选 #${s.tag}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              ctx.onTag?.(s.tag);
            }}
          >
            #{s.tag}
          </button>
        ) : (
          <Marked key={i} text={s.value} terms={ctx.terms} />
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
        const kids = <Inlines nodes={n.c} ctx={ctx} />;
        return n.t === "b" ? <strong key={i}>{kids}</strong> : n.t === "i" ? <em key={i}>{kids}</em> : n.t === "u" ? <u key={i}>{kids}</u> : <s key={i}>{kids}</s>;
      })}
    </>
  );
}

/** Note text: light formatting (bold / italic / underline / strikethrough / lists) plus `#tags` as clickable chips. */
export function NoteText({
  text,
  terms,
  activeTags,
  onTag,
  className = "note-text",
}: {
  text: string;
  terms?: string[];
  activeTags?: string[];
  onTag?(tag: string): void;
  className?: string;
}) {
  const ctx: Ctx = { terms, activeTags, onTag };
  return (
    <div className={className}>
      {parseBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <Inlines key={i} nodes={parseInline(b.text)} ctx={ctx} />
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
