import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, CircleHelp, RotateCcw, Sparkles, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import { notesStore, useNotesVersion, type NoteHit } from "../notes/store";
import type { Theme } from "../settings";
import { daysBetween, addDays } from "../tasks/date";
import { fmtDate, t } from "../i18n";
import { Review, ReviewCard } from "../components/Review";
import { answerNote, ensureReviewItems, postponeNote, reviewSettings, stopReviewing, todayQueue, type TodayQueue } from "./engine";
import { answer, streak, type Rating, type ReviewItem } from "./schedule";
import { useReviewData } from "./store";
import "./review.css";

const RATINGS: { rating: Rating; label: "nr.forgot" | "nr.fuzzy" | "nr.known"; cls: string; icon: React.ReactNode }[] = [
  { rating: 0, label: "nr.forgot", cls: "no", icon: <X size={15} /> },
  { rating: 1, label: "nr.fuzzy", cls: "mid", icon: <CircleHelp size={15} /> },
  { rating: 2, label: "nr.known", cls: "yes", icon: <Check size={15} /> },
];

const ago = (day: string, today: string) => {
  const n = daysBetween(day, today);
  if (n <= 0) return t("review.today");
  if (n < 30) return t("time.dayAgo", { n });
  if (n < 365) return t("review.monthsAgo", { n: Math.floor(n / 30) });
  return t("review.yearsAgo", { n: Math.floor(n / 365) });
};

/** The notes page's review: today's notes, one at a time, answered with "forgot / fuzzy / remembered". */
export function NoteReview({ books, theme, onOpenNote, notify }: { books: Map<string, BookRecord>; theme: Theme; onOpenNote(h: NoteHit): void; notify?(msg: string): void }) {
  const data = useReviewData();
  const notesVersion = useNotesVersion();
  const [mode, setMode] = useState<"due" | "random">("due");
  const [queue, setQueue] = useState<TodayQueue | null>(null);
  const settings = reviewSettings();

  useEffect(() => {
    if (mode !== "due" || settings.reviewOn === false) return;
    let alive = true;
    (async () => {
      await ensureReviewItems();
      const q = await todayQueue();
      if (alive) setQueue(q);
    })();
    return () => {
      alive = false;
    };
  }, [mode, data, notesVersion, settings.reviewOn]);

  const cur = queue?.hits[0];
  const item: ReviewItem | undefined = cur ? data.items.find((i) => i.noteId === cur.note.id) : undefined;

  const choose = async (rating: Rating) => {
    if (cur) await answerNote(cur.note.id, rating);
  };
  // 1 / 2 / 3 answer, as long as no text box has the keyboard
  useEffect(() => {
    if (mode !== "due" || !cur) return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const r = ({ "1": 0, "2": 1, "3": 2 } as Record<string, Rating>)[e.key];
      if (r !== undefined) void answerNote(cur.note.id, r);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [mode, cur]);

  const today = queue?.today ?? "";
  const days = useMemo(() => (item && today ? RATINGS.map((r) => daysBetween(today, answer(item, r.rating, today).due)) : []), [item, today]);
  const tomorrow = today ? data.items.filter((i) => !i.suspended && i.due === addDays(today, 1)).length : 0;
  const dateLabel = `${fmtDate(new Date(), { month: "long", day: "numeric" })} · ${fmtDate(new Date(), { weekday: "long" })}`;

  if (mode === "random") {
    return (
      <div className="nr">
        <button className="nr-back" onClick={() => setMode("due")}>
          <RotateCcw size={14} /> {t("nr.back")}
        </button>
        <Review books={books} theme={theme} onOpenNote={onOpenNote} />
      </div>
    );
  }

  const left = queue?.hits.length ?? 0;
  const done = queue?.doneToday ?? 0;
  const head = (
    <header className="nr-head">
      <div>
        <div className="review-date">{dateLabel}</div>
        <h2>
          <Sparkles size={20} /> {t("review.title")}
        </h2>
      </div>
      {settings.reviewOn !== false && queue && (
        <div className="nr-progress">
          <span>{t("nr.todayLine", { n: done + left, done })}</span>
          <i>
            <b style={{ width: `${done + left ? Math.round((done / (done + left)) * 100) : 100}%` }} />
          </i>
        </div>
      )}
    </header>
  );

  if (settings.reviewOn === false) {
    return (
      <div className="nr">
        {head}
        <p className="nr-note">{t("nr.off")}</p>
        <button className="batch-btn" onClick={() => setMode("random")}>
          {t("nr.random")}
        </button>
      </div>
    );
  }
  if (!queue) {
    return (
      <div className="nr">
        {head}
        <p className="nr-note">{t("nr.loading")}</p>
      </div>
    );
  }
  if (!cur) {
    return (
      <div className="nr">
        {head}
        <div className="nr-done">
          <Sparkles size={26} />
          <h3>{done > 0 ? t("nr.doneTitle") : t("nr.nothingTitle")}</h3>
          <p>{done > 0 ? t("nr.doneSub", { streak: streak(data.log, today), n: tomorrow }) : t("nr.nothingSub")}</p>
          {queue.dueTotal > 0 && done > 0 && <p className="nr-more">{t("nr.more", { n: queue.dueTotal })}</p>}
          <button className="batch-btn" onClick={() => setMode("random")}>
            {t("nr.random")}
          </button>
        </div>
      </div>
    );
  }
  const freeNote = cur.note.kind === "free";
  return (
    <div className="nr">
      {head}
      <div className="nr-stage">
        <ReviewCard key={cur.note.id} hit={cur} books={books} theme={theme} onOpenNote={onOpenNote}>
          <div className="nr-meta">{item && item.reps > 0 ? t("nr.last", { ago: ago(item.last, today), n: item.reps + 1 }) : t("nr.first")}</div>
        </ReviewCard>
        <div className="nr-answer">
          {RATINGS.map((r, i) => (
            <button key={r.rating} className={`nr-btn ${r.cls}`} onClick={() => void choose(r.rating)}>
              <span className="nr-btn-l">
                {r.icon} {t(r.label)}
              </span>
              <small>{days[i] ? t("nr.days", { n: days[i] }) : ""}</small>
            </button>
          ))}
        </div>
        <div className="nr-extra">
          <span className="nr-keys">{t("nr.keys")}</span>
          <button onClick={() => void postponeNote(cur.note.id)}>
            <ArrowRight size={13} /> {t("nr.postpone")}
          </button>
          <button
            onClick={async () => {
              await stopReviewing(cur.note.id);
              notify?.(t("nr.stopped"));
            }}
          >
            {t("nr.stop")}
          </button>
          {!freeNote && <span className="nr-sp" />}
        </div>
        {queue.dueTotal > left + done && <p className="nr-more">{t("nr.more", { n: queue.dueTotal - left })}</p>}
      </div>
      <button className="nr-random" onClick={() => setMode("random")}>
        {t("nr.random")}
      </button>
    </div>
  );
}

void notesStore;

/** How many notes are still to be read today (for the badge on the notes page and the desktop card). */
export function useDueCount(): number {
  const data = useReviewData();
  const notesVersion = useNotesVersion();
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    if (reviewSettings().reviewOn === false) return setN(0);
    todayQueue().then((q) => alive && setN(q.hits.length), () => {});
    return () => {
      alive = false;
    };
  }, [data, notesVersion]);
  return n;
}
