import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw, Sparkles } from "lucide-react";
import type { BookRecord } from "../core/types";
import { swatch } from "../core/palette";
import { notesStore, useNotesVersion, type NoteHit } from "../notes/store";
import type { Theme } from "../settings";
import { NoteText } from "./NoteText";
import { NoteImages, RegionQuote } from "./NoteImages";
import { fmtDate, t } from "../i18n";
import { docLabel } from "../host/label";

const PER_DAY = 5;
const DAY = 86_400_000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const ago = (ts: number) => {
  const days = Math.floor((startOfToday() - ts) / DAY) + 1;
  if (days < 1) return t("review.today");
  if (days < 30) return t("time.dayAgo", { n: days });
  if (days < 365) return t("review.monthsAgo", { n: Math.floor(days / 30) });
  return t("review.yearsAgo", { n: Math.floor(days / 365) });
};

/** One note as the reviews show it: the passage, the thought, where it is from and when it was written. */
export function ReviewCard({ hit: h, books, theme, onOpenNote, delay = 0, children }: { hit: NoteHit; books: Map<string, BookRecord>; theme: Theme; onOpenNote(h: NoteHit): void; delay?: number; children?: React.ReactNode }) {
  const sw = swatch(h.note.color);
  const b = books.get(h.bookId);
  return (
    <article className="review-card" style={{ ["--accent" as string]: theme === "dark" ? sw.dark : sw.ink, animationDelay: `${delay}ms` }}>
      {h.note.kind === "free" ? (
        <>
          <div className="review-doc-label">{t("review.free")}</div>
          <NoteText className="review-note free" text={h.note.note} />
          <NoteImages ids={h.note.images} />
        </>
      ) : h.note.kind === "doc" ? (
        <>
          <div className="review-doc-label">{t("review.docLabel")}</div>
          <blockquote className="doc">
            <NoteText className="review-doc-text" text={h.note.note} />
          </blockquote>
        </>
      ) : (
        <>
          {h.note.anchor.region ? <RegionQuote id={h.note.anchor.thumb} page={h.note.anchor.image ? undefined : h.note.anchor.section} className="region-quote big" /> : <blockquote>{h.note.anchor.exact}</blockquote>}
          {h.note.note.trim() && <NoteText className="review-note" text={h.note.note} />}
          <NoteImages ids={h.note.images} />
        </>
      )}
      <footer>
        {h.note.kind !== "free" && <span className="nb-book">{docLabel(b?.title, h.note)}</span>}
        <span>{ago(h.note.createdAt)}</span>
        {h.note.kind !== "free" && (
          <button className="review-open" onClick={() => onOpenNote(h)}>
            {h.note.kind === "doc" ? t("review.openDoc") : t("review.goText")} <ArrowUpRight size={14} />
          </button>
        )}
      </footer>
      {children}
    </article>
  );
}

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
    return `${fmtDate(d, { month: "long", day: "numeric" })} · ${fmtDate(d, { weekday: "long" })}`;
  }, []);

  return (
    <div className="review">
      <header className="review-head">
        <div>
          <div className="review-date">{dateLabel}</div>
          <h2>
            <Sparkles size={20} /> {t("nr.randomTitle")}
          </h2>
          <p>
            {state?.total
              ? t("review.intro", { n: state.total, past: state.includesToday ? "" : t("review.past"), thoughts: onlyThoughts ? t("review.thoughts") : "", m: Math.min(PER_DAY, state.total) })
              : t("review.empty")}
          </p>
        </div>
        <div className="review-actions">
          <button className={`filter-chip ${onlyThoughts ? "on" : ""}`} onClick={() => setOnlyThoughts((v) => !v)}>
            {t("review.annotations")}
          </button>
          <button className="batch-btn" onClick={() => setRound((r) => r + 1)} disabled={!state || state.total <= PER_DAY}>
            <RefreshCw size={14} /> {t("review.shuffle")}
          </button>
        </div>
      </header>
      <div className="review-list">
        {state?.items.map((h, i) => (
          <ReviewCard key={h.note.id} hit={h} books={books} theme={theme} onOpenNote={onOpenNote} delay={i * 60} />
        ))}
      </div>
    </div>
  );
}
