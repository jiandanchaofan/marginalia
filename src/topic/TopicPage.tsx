import { useEffect, useMemo, useState } from "react";
import { docTitle } from "../host/registry";
import { isVirtualDoc } from "../host/virtualDoc";
import { loadVirtualState } from "../host/virtualState";
import { ArrowLeft, BookOpen, Check, Circle, ListChecks, NotebookText, Target } from "lucide-react";
import type { BookRecord } from "../core/types";
import { notesStore, useNotesVersion, type NoteHit, type TagInfo } from "../notes/store";
import type { Theme } from "../settings";
import { t } from "../i18n";
import { ReviewCard } from "../components/Review";
import { useTasks } from "../tasks/useTasks";
import { useGoals } from "../tasks/useGoals";
import { updateTask } from "../tasks/actions";
import { goalLabel } from "../tasks/goals";
import { booksOfTopic, childTags, goalsOfTopic, notesOfTopic, tasksOfTopic, topicTags } from "./query";
import "./topic.css";

const FIRST = 20;

/** One tag as a page of its own: its books, notes, to-dos and the goals they support. */
export function TopicPage({ tag, books, theme, onOpenNote, onOpenBook, onPickTag, onBack }: { tag: string; books: Map<string, BookRecord>; theme: Theme; onOpenNote(h: NoteHit): void; onOpenBook(id: string): void; onPickTag(tag: string): void; onBack(): void }) {
  const version = useNotesVersion();
  const allTasks = useTasks();
  const { goals, links } = useGoals();
  const [withKids, setWithKids] = useState(true);
  const [all, setAll] = useState<NoteHit[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [shown, setShown] = useState(FIRST);
  const [showDone, setShowDone] = useState(false);
  const [allKids, setAllKids] = useState(false);
  const roots = useMemo(() => topicTags(tag), [tag]);

  useEffect(() => setShown(FIRST), [tag, withKids]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await notesStore.query({ tags: [tag], tagMode: "or", sort: "time", limit: -1 });
      const list = await notesStore.tags();
      if (alive) (setAll(r.items), setTags(list));
    })();
    return () => {
      alive = false;
    };
  }, [tag, version]);

  const hits = useMemo(() => notesOfTopic(all, roots, withKids), [all, roots, withKids]);
  const tasks = useMemo(() => tasksOfTopic(allTasks, roots, withKids), [allTasks, roots, withKids]);
  const open = tasks.filter((x) => !x.done);
  const done = tasks.filter((x) => x.done);
  const bookRows = useMemo(() => booksOfTopic(hits), [hits]);
  const goalRows = useMemo(() => goalsOfTopic(tasks, links, goals), [tasks, links, goals]);
  const kids = useMemo(() => childTags(tags, tag), [tags, tag]);
  const parts = tag.split("/");
  const pct = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

  const taskLine = (x: (typeof tasks)[number]) => (
    <li key={x.id} className={x.done ? "done" : ""}>
      <button className="tp-check" title={x.done ? t("tp.reopen") : t("tp.finish")} onClick={() => void updateTask(x, { done: !x.done })}>
        {x.done ? <Check size={14} /> : <Circle size={14} />}
      </button>
      <span className="tp-title">{x.title}</span>
      {x.plan && <span className="tp-plan">{x.plan}</span>}
    </li>
  );

  return (
    <div className="tp">
      <button className="nr-back" onClick={onBack}>
        <ArrowLeft size={14} /> {t("tp.back")}
      </button>
      <header className="tp-head">
        <div className="tp-path">
          {parts.length > 1 && parts.map((p, i) => {
            const to = parts.slice(0, i + 1).join("/");
            return (
              <span key={to}>
                {i > 0 && " / "}
                {i < parts.length - 1 ? <button onClick={() => onPickTag(to)}>{p}</button> : <b>{p}</b>}
              </span>
            );
          })}
        </div>
        <h2>#{tag}</h2>
        <p className="tp-stat">{t("tp.stat", { notes: hits.length, books: bookRows.length, tasks: tasks.length, done: done.length })}</p>
      </header>

      {kids.length > 0 && (
        <div className={`tp-scope ${withKids ? "" : "off"}`}>
          <label className="tp-switch">
            <input type="checkbox" checked={withKids} onChange={(e) => setWithKids(e.target.checked)} />
            <span className="knob" />
            {t("tp.withKids")}
          </label>
          <span className="tp-sep" />
          <span className="tp-kidlabel">{t("tp.kids")}</span>
          <div className="tp-kidrow">
            {(allKids ? kids : kids.slice(0, 5)).map((k) => (
              <button key={k.tag} onClick={() => onPickTag(k.tag)}>
                {k.tag.split("/").pop()} <i>{k.count}</i>
              </button>
            ))}
            {kids.length > 5 && (
              <button className="more" onClick={() => setAllKids((v) => !v)}>
                {allKids ? t("tp.fewer") : `+${kids.length - 5}`}
              </button>
            )}
          </div>
          {!withKids && <span className="tp-note">{t("tp.noKids")}</span>}
        </div>
      )}

      {bookRows.length > 0 && (
        <section className="tp-sec books">
          <h3><BookOpen size={15} /> {t("tp.books")} <i>{bookRows.length}</i></h3>
          <div className="tp-blist">
            {bookRows.map((b) => {
              const rec = books.get(b.id);
              // a document a module provides (the Bible) is not on the shelf: it has its own name and remembered position
              const plugin = !rec && isVirtualDoc(b.id) ? docTitle(b.id) : "";
              const progress = rec ? rec.progress : plugin ? loadVirtualState(b.id).progress ?? 0 : 0;
              const known = !!rec || !!plugin;
              const pctRead = Math.round(progress * 100);
              return (
                <button key={b.id} className="tp-brow" disabled={!known} onClick={() => onOpenBook(b.id)}>
                  <span className="tp-btitle">{rec?.title ?? (plugin || t("kind.removedBook"))}</span>
                  <span className="tp-bmeta">
                    {known ? `${pctRead}% · ` : ""}
                    {t("unit.notes", { n: b.count })}
                  </span>
                  {known && (
                    <span className="tp-bbar">
                      <i style={{ width: `${pctRead}%` }} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {(tasks.length > 0 || goalRows.length > 0) && (
        <section className="tp-sec tasks">
          <h3><ListChecks size={15} /> {t("tp.tasks")} <i>{tasks.length}</i></h3>
          {tasks.length > 0 && (
            <div className="tp-progress">
              <span className="goal-bar wide">
                <i style={{ width: `${pct}%` }} />
              </span>
              <span>{t("topic.progress", { done: done.length, total: tasks.length, pct })}</span>
            </div>
          )}
          <ul className="tp-tasks">{open.map(taskLine)}</ul>
          {done.length > 0 && (
            <>
              <button className="tp-more" onClick={() => setShowDone((v) => !v)}>
                {showDone ? t("tp.hideDone") : t("tp.showDone", { n: done.length })}
              </button>
              {showDone && <ul className="tp-tasks">{done.map(taskLine)}</ul>}
            </>
          )}
          {goalRows.length > 0 && (
            <div className="tp-goals">
              {goalRows.map(({ goal, count }) => (
                <span key={goal.id} className="tp-goal">
                  <Target size={13} /> {goalLabel(goal)} · {goal.title} <i>{count}</i>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="tp-sec notes">
        <h3><NotebookText size={15} /> {t("tp.notes", { n: hits.length })}</h3>
        {hits.length === 0 && <p className="nr-note">{t("tp.noNotes")}</p>}
        <div className="tp-notes">
          {hits.slice(0, shown).map((h) => (
            <ReviewCard key={h.note.id} hit={h} books={books} theme={theme} onOpenNote={onOpenNote} />
          ))}
        </div>
        {hits.length > shown && (
          <button className="tp-more" onClick={() => setShown((n) => n + FIRST)}>
            {t("tp.more", { n: hits.length - shown })}
          </button>
        )}
      </section>
    </div>
  );
}
