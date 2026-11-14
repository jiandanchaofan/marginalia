import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { t } from "../i18n";
import type { TextHit } from "./backend";

/**
 * Beside the page, for a while: every place in this book where the searched words appear, like a table of contents.
 * Click one (as often as you like) to go there; the up / down buttons and F3 / Shift + F3 step through them.
 */
export function FindPanel({ text, hits, current, total, titleOf, truncated, onPick, onClose }: { text: string; hits: TextHit[]; current: number; /** Places boxed in the whole book (a paragraph can hold several). */ total: number; titleOf(section: number): string; truncated: boolean; onPick(i: number): void; onClose(): void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".fp-hit.on")?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const step = (d: number) => onPick((current + d + hits.length) % hits.length);

  // group by section, in reading order
  const groups: { section: number; items: { h: TextHit; i: number }[] }[] = [];
  hits.forEach((h, i) => {
    const g = groups.find((x) => x.section === h.section);
    if (g) g.items.push({ h, i });
    else groups.push({ section: h.section, items: [{ h, i }] });
  });

  return (
    <aside className="fp" aria-label={t("fp.title", { q: text })}>
      <header className="fp-head">
        <div className="fp-title">
          <b>{t("fp.title", { q: text })}</b>
          <span>{total > hits.length ? t("fp.countMore", { n: total, m: hits.length, at: current + 1 }) : t("fp.count", { n: hits.length, at: current + 1 })}</span>
        </div>
        <button className="icon-btn" onClick={() => step(-1)} title={t("fp.prev")}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" onClick={() => step(1)} title={t("fp.next")}>
          <ChevronDown size={16} />
        </button>
        <button className="icon-btn" onClick={onClose} title={t("fp.close")}>
          <X size={16} />
        </button>
      </header>
      <div className="fp-list" ref={list}>
        {groups.map((g) => (
          <section key={g.section}>
            <div className="fp-sec">{titleOf(g.section)}</div>
            {g.items.map(({ h, i }) => (
              <button key={i} className={`fp-hit ${i === current ? "on" : ""}`} onClick={() => onPick(i)}>
                <Marked text={h.snippet} term={text} />
              </button>
            ))}
          </section>
        ))}
        {truncated && <p className="fp-more">{t("fp.many", { n: hits.length })}</p>}
      </div>
    </aside>
  );
}

function Marked({ text, term }: { text: string; term: string }) {
  const i = term ? text.toLowerCase().indexOf(term.trim().toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  const n = term.trim().length;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  );
}
