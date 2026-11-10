import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw, Sparkles } from "lucide-react";
import type { BookRecord } from "../core/types";
import { swatch } from "../core/palette";
import { notesStore, useNotesVersion, type NoteHit } from "../notes/store";
import type { Theme } from "../settings";
import { NoteText } from "./NoteText";
import { NoteImages } from "./NoteImages";

const PER_DAY = 5;
const DAY = 86_400_000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const ago = (t: number) => {
  const days = Math.floor((startOfToday() - t) / DAY) + 1;
  if (days < 1) return "今天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
};

/**
 * Daily review: a stable-per-day random pick of past notes (seeded shuffle in the store),
 * so reopening the app the same day shows the same set until "换一批".
 */
export function Review({ books, theme, onOpenNote }: { books: Map<string, BookRecord>; theme: Theme; onOpenNote(h: NoteHit): void }) {
  const version = useNotesVersion();
  const [round, setRound] = useState(0);
  const [onlyThoughts, setOnlyThoughts] = useState(true);
  const [state, setState] = useState<{ items: NoteHit[]; total: number; includesToday: boolean } | null>(null);
  const today = startOfToday();
  const day = Math.floor((today - new Date().getTimezoneOffset() * 60_000) / DAY);
  const seed = day * 13 + round * 7;

  useEffect(() => {
    let alive = true;
    (async () => {
      const base = { sort: "shuffle" as const, seed, limit: PER_DAY, hasText: onlyThoughts || undefined };
      let r = await notesStore.query({ ...base, before: today });
      let includesToday = false;
      // Nothing older than today yet: fall back to everything so the view is never empty for new users.
      if (!r.total) {
        r = await notesStore.query(base);
        includesToday = true;
      }
      if (alive) setState({ ...r, includesToday });
    })();
    return () => {
      alive = false;
    };
  }, [seed, onlyThoughts, today, version]);

  const dateLabel = useMemo(() => {
    const d = new Date();
    return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${"日一二三四五六"[d.getDay()]}`;
  }, []);

  return (
    <div className="review">
      <header className="review-head">
        <div>
          <div className="review-date">{dateLabel}</div>
          <h2>
            <Sparkles size={20} /> 每日回顾
          </h2>
          <p>
            {state?.total
              ? `从 ${state.total} 条${state.includesToday ? "" : "过往"}${onlyThoughts ? "有想法的" : ""}笔记中，为今天挑出 ${Math.min(PER_DAY, state.total)} 条。`
              : "写下带想法的笔记后，这里每天会为你挑几条旧笔记重读。"}
          </p>
        </div>
        <div className="review-actions">
          <button className={`filter-chip ${onlyThoughts ? "on" : ""}`} onClick={() => setOnlyThoughts((v) => !v)}>
            批注笔记
          </button>
          <button className="batch-btn" onClick={() => setRound((r) => r + 1)} disabled={!state || state.total <= PER_DAY}>
            <RefreshCw size={14} /> 换一批
          </button>
        </div>
      </header>
      <div className="review-list">
        {state?.items.map((h, i) => {
          const sw = swatch(h.note.color);
          const b = books.get(h.bookId);
          return (
            <article key={h.note.id} className="review-card" style={{ ["--accent" as string]: theme === "dark" ? sw.dark : sw.ink, animationDelay: `${i * 60}ms` }}>
              {h.note.kind === "free" ? (
                <>
                  <div className="review-doc-label">随手记</div>
                  <NoteText className="review-note free" text={h.note.note} />
                  <NoteImages ids={h.note.images} />
                </>
              ) : h.note.kind === "doc" ? (
                <>
                  <div className="review-doc-label">阅读全局笔记</div>
                  <blockquote className="doc">
                    <NoteText className="review-doc-text" text={h.note.note} />
                  </blockquote>
                </>
              ) : (
                <>
                  <blockquote>{h.note.anchor.exact}</blockquote>
                  {h.note.note.trim() && <NoteText className="review-note" text={h.note.note} />}
                  <NoteImages ids={h.note.images} />
                </>
              )}
              <footer>
                {h.note.kind !== "free" && <span className="nb-book">{b?.title ?? "已移除的书"}</span>}
                <span>{ago(h.note.createdAt)}</span>
                {h.note.kind !== "free" && (
                  <button className="review-open" onClick={() => onOpenNote(h)}>
                    {h.note.kind === "doc" ? "打开整体笔记" : "回到原文"} <ArrowUpRight size={14} />
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
