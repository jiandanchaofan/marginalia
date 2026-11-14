import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { notesStore, useNotesVersion, type TagInfo } from "../notes/store";
import { t, collate } from "../i18n";
import { useTasks } from "../tasks/useTasks";
import { tasksOfTopic, topicTags } from "./query";
import "./topic.css";

type Sort = "notes" | "name";

/** Every top-level tag as a topic card: how many notes and to-dos it holds, its sub-tags; click one to open its page. */
export function TopicsOverview({ onOpen }: { onOpen(tag: string): void }) {
  const version = useNotesVersion();
  const tasks = useTasks();
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("notes");

  useEffect(() => {
    notesStore.tags().then(setTags);
  }, [version]);

  const cards = useMemo(() => {
    const top = tags.filter((x) => !x.tag.includes("/"));
    const rows = top.map((x) => {
      const mine = tasksOfTopic(tasks, topicTags(x.tag));
      const kids = tags.filter((k) => k.tag.startsWith(`${x.tag}/`) && k.tag.split("/").length === 2).sort((a, b) => b.count - a.count);
      return { tag: x.tag, notes: x.count, tasks: mine.length, done: mine.filter((m) => m.done).length, kids };
    });
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    const list = needle ? rows.filter((r) => r.tag.toLowerCase().includes(needle) || r.kids.some((k) => k.tag.toLowerCase().includes(needle))) : rows;
    return list.sort((a, b) => (sort === "notes" ? b.notes + b.tasks - (a.notes + a.tasks) : collate(a.tag, b.tag)));
  }, [tags, tasks, q, sort]);

  return (
    <div className="tp">
      <header className="tp-head">
        <h2>{t("tpo.title")}</h2>
        <p className="tp-stat">{t("tpo.sub", { n: cards.length })}</p>
      </header>
      <div className="tpo-bar">
        <label className="tpo-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tpo.search")} spellCheck={false} />
        </label>
        <div className="segmented">
          <button className={sort === "notes" ? "on" : ""} onClick={() => setSort("notes")}>
            {t("tpo.byCount")}
          </button>
          <button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>
            {t("tpo.byName")}
          </button>
        </div>
      </div>
      {cards.length === 0 && <p className="nr-note">{t("tpo.empty")}</p>}
      <div className="tpo-grid">
        {cards.map((c) => (
          <div key={c.tag} className="tpo-card" role="button" tabIndex={0} onClick={() => onOpen(c.tag)} onKeyDown={(e) => e.key === "Enter" && onOpen(c.tag)}>
            <b>#{c.tag}</b>
            <span className="tpo-num">
              {t("tpo.counts", { notes: c.notes, tasks: c.tasks })}
            </span>
            {c.tasks > 0 && (
              <span className="goal-bar wide">
                <i style={{ width: `${Math.round((c.done / c.tasks) * 100)}%` }} />
              </span>
            )}
            {c.kids.length > 0 && (
              <span className="tpo-kids">
                {c.kids.slice(0, 4).map((k) => (
                  <button
                    key={k.tag}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(k.tag);
                    }}
                  >
                    {k.tag.split("/").pop()}
                  </button>
                ))}
                {c.kids.length > 4 && <i>+{c.kids.length - 4}</i>}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
