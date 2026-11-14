import { useEffect, useRef, useState } from "react";
import { notesStore, useNotesVersion, type NoteHit } from "../notes/store";
import { stripTags } from "../notes/tags";
import { isFreeNote } from "../core/types";
import { loadLibrary } from "../platform";
import { t } from "../i18n";
import { Heatmap } from "./Heatmap";
import { openInMain } from "../cards/nav";
import { answerNote, ensureReviewItems, reviewSettings, todayQueue } from "../review/engine";
import { useReviewData } from "../review/store";

const DAY = 86_400_000;
const PICK = 10;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const agoLabel = (ts: number) => {
  const days = Math.floor((startOfToday() - ts) / DAY) + 1;
  if (days < 1) return t("review.today");
  if (days < 30) return t("time.dayAgo", { n: days });
  if (days < 365) return t("review.monthsAgo", { n: Math.floor(days / 30) });
  return t("review.yearsAgo", { n: Math.floor(days / 365) });
};

/** One daily-review note at a time, turning over by itself (and standing still while the pointer is on it). */
function ReviewPane({ long, secs }: { long: boolean; secs: number }) {
  const version = useNotesVersion();
  const [items, setItems] = useState<NoteHit[]>([]);
  const [i, setI] = useState(0);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const paused = useRef(false);
  const reviewData = useReviewData();
  const [due, setDue] = useState(false);

  useEffect(() => {
    loadLibrary().then(
      (books) => setTitles(new Map(books.map((b) => [b.id, b.title]))),
      () => {},
    );
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (reviewSettings().reviewOn !== false) {
        await ensureReviewItems();
        const q = await todayQueue();
        if (q.hits.length) {
          if (alive) {
            setItems(q.hits.slice(0, 1));
            setDue(true);
            setI(0);
          }
          return;
        }
      }
      if (alive) setDue(false);
      const today = startOfToday();
      const day = Math.floor((today - new Date().getTimezoneOffset() * 60_000) / DAY);
      const base = { sort: "shuffle" as const, seed: day * 13, limit: PICK, hasText: true };
      let r = await notesStore.query({ ...base, before: today });
      if (!r.total) r = await notesStore.query(base);
      if (alive) {
        setItems(r.items);
        setI(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [version, reviewData]);

  useEffect(() => {
    if (!secs || due || items.length < 2) return;
    const id = window.setInterval(() => {
      if (!paused.current) setI((x) => (x + 1) % items.length);
    }, secs * 1000);
    return () => window.clearInterval(id);
  }, [secs, items.length, due]);

  if (!items.length) return <div className="nc-review empty">{t("nc.empty")}</div>;
  const hit = items[Math.min(i, items.length - 1)];
  const n = hit.note;
  const quote = !isFreeNote(n) && n.kind !== "doc" && !n.anchor.region ? n.anchor.exact?.trim() : "";
  const source = isFreeNote(n) ? t("kind.free") : titles.get(hit.bookId) ?? "";
  const tags = n.tags ?? [];
  return (
    <div className="nc-review" onMouseEnter={() => (paused.current = true)} onMouseLeave={() => (paused.current = false)}>
      <button className="nc-note" onClick={() => void openInMain({ to: "note", id: n.id })}>
        <span className="nc-meta">
          <b>{source}</b>
          <span>{agoLabel(n.createdAt)}</span>
        </span>
        {quote && <span className="nc-quote">{quote}</span>}
        <span className="nc-text">{stripTags(n.note).trim()}</span>
        {long && tags.length > 0 && (
          <span className="nc-tags">
            {tags.slice(0, 3).map((x) => (
              <i key={x}>#{x}</i>
            ))}
          </span>
        )}
      </button>
      {due && (
        <div className="nc-rate">
          {([[0, "nr.forgot"], [1, "nr.fuzzy"], [2, "nr.known"]] as const).map(([r, k]) => (
            <button key={r} className={`r${r}`} onClick={() => void answerNote(n.id, r)}>
              {t(k)}
            </button>
          ))}
        </div>
      )}
      {!due && long && items.length > 1 && (
        <div className="nc-foot">
          <span className="nc-dots">
            {items.slice(0, 8).map((_, k) => (
              <i key={k} className={k === i % 8 ? "on" : ""} />
            ))}
          </span>
          <button className="nc-next" onClick={() => setI((x) => (x + 1) % items.length)}>
            {t("nc.next")}
          </button>
        </div>
      )}
    </div>
  );
}

export function NotesCard({ w, h, secs }: { w: number; h: number; secs: number }) {
  const level = h < 235 ? 0 : h < 430 ? 1 : 2;
  const wide = w >= 520 && level >= 1;
  return (
    <div className={`nc nc-${level} ${wide ? "wide" : ""}`}>
      <div className="nc-stats">
        <Heatmap onPick={() => void openInMain({ to: "notes" })} />
      </div>
      {level >= 1 && <ReviewPane long={level === 2 || wide} secs={secs} />}
    </div>
  );
}
