import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, isFreeNote, type Annotation, type BookRecord } from "../core/types";
import { DEFAULT_SETTINGS, normalizeSettings } from "../settings";
import { settingsStore } from "../platform";
import { fmtDate, shortDay, t } from "../i18n";
import { notesStore, useNotesVersion, type NoteHit } from "../notes/store";
import { makeLink } from "../notes/links";
import { parseTags, stripTags } from "../notes/tags";
import { addDays, isoWeekOf, planOf, todayStr } from "../tasks/date";
import { createTask } from "../tasks/actions";
import { goalsIn, paceOf, progressOfGoal, supportMap } from "../tasks/goals";
import { isOverdue } from "../tasks/query";
import { useGoals } from "../tasks/useGoals";
import { useTasks } from "../tasks/useTasks";
import { weekTag } from "../tasks/words";
import { rememberWeekTag, weekReviewTags } from "../notes/aliases";
import { percentBefore, recordGoalSnaps, snapStore, type Snap } from "../tasks/snaps";
import { useReading } from "./store";
import { useReviewData } from "../review/store";
import { fmtSecs, weekRange, weekStats } from "./stats";
import "./reading.css";

const level = (secs: number) => (secs < 60 ? 0 : secs < 900 ? 1 : secs < 1800 ? 2 : secs < 3600 ? 3 : 4);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const doneKey = (start: string) => `reader:weekly-done:${start}`;
const hideKey = (start: string) => `reader:weekly-hide:${start}`;
const flag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const setFlag = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    /* storage unavailable */
  }
};
const settingsNow = () => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS));
const weekStartNow = (): 0 | 1 => (settingsNow().weekStart === 0 ? 0 : 1);

/** The note that is the most worth reading again: the longest thoughts, and those tied to other notes. */
function rereads(notes: NoteHit[], linkCount: Map<string, number>): NoteHit[] {
  return notes
    .map((h) => ({ h, text: stripTags(h.note.note).trim() }))
    .filter((x) => x.text.length >= 20)
    .map((x) => ({ ...x, score: x.text.length + 60 * (linkCount.get(x.h.note.id) ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.h);
}

export function WeeklyReview({ books, notify, onOpenNote }: { books: Map<string, BookRecord>; notify(msg: string): void; onOpenNote(hit: NoteHit): void }) {
  const weekStart = weekStartNow();
  const [off, setOff] = useState(0);
  const today = todayStr();
  const thisWeek = weekRange(today, weekStart);
  const start = addDays(thisWeek.start, off * 7);
  const end = addDays(start, 6);
  const rows = useReading();
  const reviewLog = useReviewData().log;
  const tasks = useTasks();
  const { goals, links } = useGoals();
  const version = useNotesVersion();
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [linkCount, setLinkCount] = useState<Map<string, number>>(new Map());
  const [past, setPast] = useState<NoteHit[]>([]);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [ans, setAns] = useState(["", "", ""]);
  const [saved, setSaved] = useState(() => flag(doneKey(start)));

  useEffect(() => setSaved(flag(doneKey(start))), [start]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const after = new Date(`${start}T00:00:00`).getTime();
      const before = new Date(`${addDays(end, 1)}T00:00:00`).getTime();
      const r = await notesStore.query({ sort: "time", after, before, limit: -1 });
      const all = await notesStore.links();
      const count = new Map<string, number>();
      for (const l of all) {
        count.set(l.a, (count.get(l.a) ?? 0) + 1);
        count.set(l.b, (count.get(l.b) ?? 0) + 1);
      }
      const reviews = await notesStore.query({ sort: "time", tags: weekReviewTags(), tagMode: "or", limit: -1 });
      if (!alive) return;
      setNotes(r.items);
      setLinkCount(count);
      setPast(reviews.items);
    })();
    return () => {
      alive = false;
    };
  }, [start, end, version]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await recordGoalSnaps().catch(() => {});
      const all = await snapStore.all().catch(() => []);
      if (alive) setSnaps(all);
    })();
    return () => {
      alive = false;
    };
  }, [start, goals, tasks]);

  const week = useMemo(() => weekStats(rows, start, end), [rows, start, end]);
  const doneTasks = useMemo(() => {
    const a = new Date(`${start}T00:00:00`).getTime();
    const b = new Date(`${addDays(end, 1)}T00:00:00`).getTime();
    return tasks.filter((x) => x.done && x.doneAt !== null && x.doneAt >= a && x.doneAt < b).length;
  }, [tasks, start, end]);
  const overdue = useMemo(() => tasks.filter((x) => isOverdue(x, today)).length, [tasks, today]);
  const support = useMemo(() => supportMap(links, tasks), [links, tasks]);
  const monthGoals = useMemo(() => goalsIn(goals, "month", planOf("month", today).raw), [goals, today]);
  const worth = useMemo(() => rereads(notes, linkCount), [notes, linkCount]);
  const topTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of notes) for (const tag of new Set(parseTags(h.note.note))) m.set(tag, (m.get(tag) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [notes]);

  const n = isoWeekOf(addDays(start, weekStart === 0 ? 1 : 0)).week;
  const range = t("wr.range", { a: shortDay(start), b: shortDay(end) });
  const summary = t("wr.summary", {
    read: week.secs >= 60 ? t("wr.sumRead", { time: fmtSecs(week.secs) }) : t("wr.sumNoRead"),
    notes: t("wr.sumNotes", { n: notes.length }),
    tasks: t("wr.sumTasks", { n: doneTasks }),
  });
  const weekdayLabel = (i: number) => fmtDate(new Date(`${addDays(start, i)}T00:00:00`), { weekday: "narrow" });
  const titleOf = (id: string) => books.get(id)?.title ?? "";

  const save = async () => {
    const [a1, a2, a3] = ans.map((x) => x.trim());
    if (!a1 && !a2 && !a3) return notify(t("wr.empty"));
    const now = Date.now();
    const lines = [`#${weekTag()} ${t("wr.noteTitle", { n, range })}`];
    if (a1) lines.push(`${t("wr.l1")}：${a1}`);
    if (a2) lines.push(`${t("wr.l2")}：${a2}`);
    if (a3) lines.push(`${t("wr.l3")}：${a3}`);
    const note = lines.join("\n");
    const a: Annotation = { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note, tags: parseTags(note), side: "right", kind: "free", createdAt: now, updatedAt: now };
    try {
      rememberWeekTag(weekTag());
      await notesStore.add(FREE_BOOK, a);
      if (worth[0]) await notesStore.putLinks([makeLink(a.id, worth[0].note.id, t("wr.linkLabel"))]);
      if (a3) await createTask({ title: a3.split("\n")[0], plan: planOf("week", addDays(start, 7)) });
      setFlag(doneKey(start));
      setSaved(true);
      setAns(["", "", ""]);
      notify(a3 ? t("wr.savedNext") : t("wr.saved"));
    } catch (e) {
      notify(String(e));
    }
  };

  return (
    <div className="wr">
      <div className="wr-head">
        <h2>{t("wr.title", { n, range })}</h2>
        <span className="wr-nav">
          <button title={t("wr.prev")} onClick={() => setOff(off - 1)}>
            <ChevronLeft size={14} />
          </button>
          <button disabled={off === 0} onClick={() => setOff(0)}>
            {t("wr.now")}
          </button>
          <button title={t("wr.next")} disabled={off >= 0} onClick={() => setOff(off + 1)}>
            <ChevronRight size={14} />
          </button>
        </span>
      </div>
      <p className="wr-sum">{summary}</p>
      {(() => {
        const l = reviewLog.filter((x) => x.day >= start && x.day <= end);
        if (!l.length) return null;
        const known = Math.round((l.filter((x) => x.rating === 2).length / l.length) * 100);
        return <p className="wr-sum">{t("nr.weekLine", { n: l.length, p: known })}</p>;
      })()}

      <section className="wr-card">
        <div className="wr-sec">{t("wr.sReading")}</div>
      {week.secs < 60 ? (
        <p className="wr-sum">{t("wr.noReading")}</p>
      ) : (
        <div className="wr-grid">
          <div>
            <div className="kpis">
              <div>
                <b>{fmtSecs(week.secs)}</b>
                <span>{t("wr.time")}</span>
              </div>
              <div>
                <b>{week.days}</b>
                <span>{t("wr.daysRead")}</span>
              </div>
            </div>
            <div className="wr-week">
              {week.perDay.map((s, i) => (
                <div key={i} title={`${shortDay(addDays(start, i))} · ${fmtSecs(s)}`}>
                  <i className={s ? `l${level(s)}` : ""} />
                  {weekdayLabel(i)}
                </div>
              ))}
            </div>
          </div>
          <div>
            {week.books.slice(0, 5).map((b) => (
              <div className="wr-book" key={b.bookId}>
                <div>
                  <div className="t">{titleOf(b.bookId) || "—"}</div>
                  <div className="wr-bar">
                    <i style={{ width: `${Math.round(b.from * 100)}%` }} />
                    <i className="add" style={{ left: `${Math.round(b.from * 100)}%`, width: `${Math.max(1, Math.round((b.to - b.from) * 100))}%` }} />
                  </div>
                </div>
                {b.finished ? <span className="wr-chip green">{t("wr.finished")}</span> : b.to > b.from ? <span className="wr-chip green">{t("wr.gain", { p: Math.round((b.to - b.from) * 100) })}</span> : <span className="wr-chip">{fmtSecs(b.secs)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      </section>
      <section className="wr-card">
        <div className="wr-sec">{t("wr.sNotes")}</div>
      {notes.length === 0 ? (
        <p className="wr-sum">{t("wr.noNotes")}</p>
      ) : (
        <>
          {worth.map((h) => (
            <button
              key={h.note.id}
              className="wr-note"
              onClick={() => (isFreeNote(h.note) ? notify(stripTags(h.note.note).trim().slice(0, 120)) : onOpenNote(h))}
              title={t("wr.reread")}
            >
              {stripTags(h.note.note).trim().slice(0, 200)}
              <small>
                {isFreeNote(h.note) ? t("kind.free") : titleOf(h.bookId)} · {t("wr.reread")}
              </small>
            </button>
          ))}
          {topTags.length > 0 && (
            <div className="wr-tags">
              {topTags.map(([tag, c]) => (
                <span key={tag} className="wr-chip">
                  #{tag} {c}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      </section>
      <section className="wr-card">
        <div className="wr-sec">{t("wr.sTasks")}</div>
      <div className="wr-grid">
        <div className="kpis">
          <div>
            <b>{doneTasks}</b>
            <span>{t("wr.doneCount")}</span>
          </div>
          <div>
            <b>{overdue}</b>
            <span>{t("wr.overdueCount")}</span>
          </div>
        </div>
        <div>
          {monthGoals.length === 0 ? (
            <p className="wr-sum" style={{ margin: 0 }}>
              {t("wr.noGoals")}
            </p>
          ) : (
            monthGoals.slice(0, 4).map((g) => {
              const pr = progressOfGoal(g, support);
              return (
                <div className="wr-book" key={g.id}>
                  <div>
                    <div className="t">{g.title}</div>
                    <div className="wr-bar">
                      <i style={{ width: `${pr.percent}%`, background: paceOf(g, pr, today) === "late" ? "#c0392b" : undefined }} />
                    </div>
                  </div>
                  <b style={{ fontSize: 12 }}>{pr.percent}%</b>
                  {(() => {
                    const before = percentBefore(snaps, g.id, start);
                    const d = before === null ? 0 : pr.percent - before;
                    return d !== 0 ? <span className={`wr-chip ${d > 0 ? "green" : "red"}`}>{d > 0 ? `+${d}%` : `${d}%`}</span> : null;
                  })()}
                </div>
              );
            })
          )}
        </div>
      </div>
      </section>
      <section className="wr-card">
        <div className="wr-sec">{t("wr.sWrite")}</div>
      {[t("wr.q1"), t("wr.q2"), t("wr.q3")].map((q, i) => (
        <label key={i} className="wr-ask">
          {q}
          <textarea value={ans[i]} onChange={(e) => setAns(ans.map((v, k) => (k === i ? e.target.value : v)))} />
        </label>
      ))}
      <div className="wr-save">
        <button className="primary-btn small" onClick={() => void save()}>
          {t("wr.save")}
        </button>
        <span>{saved ? t("wr.saved") : t("wr.hint", { tag: weekTag() })}</span>
      </div>
      </section>
      <section className="wr-card">
        <div className="wr-sec">{t("wr.sPast")}</div>
      {past.length === 0 ? (
        <p className="wr-sum">{t("wr.pastEmpty")}</p>
      ) : (
        <div className="wr-past">
          {past.slice(0, 12).map((h) => (
            <button key={h.note.id} onClick={() => notify(stripTags(h.note.note).trim().slice(0, 300))}>
              <span>{stripTags(h.note.note).trim().split("\n")[0]}</span>
              <small>{fmtDate(h.note.createdAt, { month: "short", day: "numeric", year: "numeric" })}</small>
            </button>
          ))}
        </div>
      )}
      </section>
    </div>
  );
}

/** A quiet line on the task page when last week has no review yet. */
export function WeeklyPrompt({ onGo }: { onGo(): void }) {
  const tasks = useTasks();
  const rows = useReading();
  const [, again] = useState(0);
  const s = settingsNow();
  if (s.weekPrompt === false || (!tasks.length && !rows.length)) return null;
  const prev = weekRange(addDays(todayStr(), -7), s.weekStart === 0 ? 0 : 1).start;
  if (flag(doneKey(prev)) || flag(hideKey(prev))) return null;
  return (
    <div className="wr-banner">
      <span>{t("wr.prompt")}</span>
      <button onClick={onGo}>{t("wr.promptGo")}</button>
      <button
        className="mute"
        onClick={() => {
          setFlag(hideKey(prev));
          again((n) => n + 1);
        }}
      >
        {t("wr.promptHide")}
      </button>
    </div>
  );
}
