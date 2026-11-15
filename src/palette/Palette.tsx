import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, isFreeNote, type Annotation, type BookRecord } from "../core/types";
import { notesStore, type NoteHit, type TagInfo } from "../notes/store";
import { notePreview } from "../notes/links";
import { parseTags } from "../notes/tags";
import { useTasks } from "../tasks/useTasks";
import { useGoals } from "../tasks/useGoals";
import { goalLabel } from "../tasks/goals";
import { t } from "../i18n";
import { docLabel } from "../host/label";
import { allCommands, type Actions } from "./commands";
import { bookIndex, type Found } from "../search/backend";
import { postIntent } from "./intent";
import { PALETTE_ID, chips, comboOf, eventCombo, ownerOf, shortcutsPaused, type Overrides } from "./shortcuts";
import "./palette.css";

type Scope = "tag" | "book" | "cmd" | "text" | null;
type Kind = "note" | "book" | "task" | "tag" | "cmd" | "page" | "goal" | "text";
interface Row {
  key: string;
  kind: Kind;
  title: string;
  sub?: string;
  hint?: string;
  keys?: string;
  run(): void;
}
interface Group {
  title: string;
  right?: string;
  rows: Row[];
}

const ICON: Record<Kind, string> = { note: "笔", book: "书", task: "✓", tag: "#", cmd: "＋", page: "页", goal: "目", text: "文" };
const RECENT_KEY = "reader:palette-recent";
const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
};
const saveRecent = (key: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...loadRecent().filter((k) => k !== key)].slice(0, 8)));
  } catch {
    /* storage unavailable */
  }
};
const PREFIX: Record<string, Scope> = { "#": "tag", "@": "book", "/": "cmd", "~": "text" };
const CAP = 4;
const DAY = 86_400_000;
const relTime = (ts: number) => {
  const d = Math.max(0, Math.floor((Date.now() - ts) / DAY));
  return d < 1 ? t("review.today") : d < 30 ? t("time.dayAgo", { n: d }) : d < 365 ? t("review.monthsAgo", { n: Math.floor(d / 30) }) : t("review.yearsAgo", { n: Math.floor(d / 365) });
};

/** 0 = starts with the text, 1 = contains it, -1 = no match. */
const rank = (text: string, q: string) => {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? -1 : i === 0 ? 0 : 1;
};
function pick<T>(items: T[], q: string, text: (x: T) => string, extra?: (x: T) => string): T[] {
  if (!q) return items;
  return items
    .map((x, n) => {
      const r = rank(text(x), q);
      const e = r < 0 && extra ? rank(extra(x), q) : -1;
      return { x, n, s: r >= 0 ? r : e >= 0 ? 2 : -1 };
    })
    .filter((m) => m.s >= 0)
    .sort((a, b) => a.s - b.s || a.n - b.n)
    .map((m) => m.x);
}

function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface Props {
  books: BookRecord[];
  actions: Actions;
  onOpenBook(id: string): void;
  onOpenNote(hit: NoteHit): void;
  onOpenTask(id: string): void;
  onOpenBookAt(id: string, target: { section: number; text: string; snippet?: string }): void;
  bookSearch?: boolean;
  notify(msg: string): void;
  shortcuts?: Overrides;
}

/** Ctrl + K: one box to find notes, books, tags and to-dos, and to run commands. */
export function Palette({ books, actions, onOpenBook, onOpenNote, onOpenTask, onOpenBookAt, bookSearch, notify, shortcuts }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>(null);
  const [sel, setSel] = useState(0);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [noteHits, setNoteHits] = useState<NoteHit[]>([]);
  const [textFound, setTextFound] = useState<Found | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tasks = useTasks();
  const { goals } = useGoals();
  const live = useRef({ actions, shortcuts });
  live.current = { actions, shortcuts };
  const q = text.trim().toLowerCase();

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (shortcutsPaused() || e.isComposing) return;
      const combo = eventCombo(e);
      if (!combo) return;
      const { actions: a, shortcuts: over } = live.current;
      const id = ownerOf(combo, over);
      if (!id) return;
      if (id === PALETTE_ID) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      const cmd = allCommands(a.desktop).find((c) => c.id === id);
      if (!cmd) return;
      e.preventDefault();
      setOpen(false);
      cmd.run(a);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setText("");
    setScope(null);
    setSel(0);
    setNoteHits([]);
    setTextFound(null);
    notesStore.tags().then(setTags, () => {});
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  // notes are searched in the database, a moment after typing stops
  useEffect(() => {
    if (!open || scope || q.length < 2) return void setNoteHits([]);
    let alive = true;
    const id = window.setTimeout(() => {
      notesStore.query({ terms: [q], sort: "time", limit: 6 }).then(
        (r) => alive && setNoteHits(r.items),
        () => {},
      );
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [open, scope, q]);

  // the books' own text: searched in the index, a moment after typing stops (the last group, and only with 2+ characters)
  useEffect(() => {
    if (!open || bookSearch === false || (scope && scope !== "text") || [...q].length < 2) return void setTextFound(null);
    let alive = true;
    const id = window.setTimeout(() => {
      bookIndex.search(text, scope === "text" ? 3 : 2, scope === "text" ? 30 : 8).then(
        (f) => alive && setTextFound(f),
        () => {},
      );
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [open, scope, q, text, bookSearch]);

  const close = () => setOpen(false);
  const cmds = useMemo(() => (open ? allCommands(actions.desktop) : []), [open, actions.desktop]);

  const groups = useMemo<Group[]>(() => {
    if (!open) return [];
    const out: Group[] = [];
    const cmdRow = (c: (typeof cmds)[number]): Row => ({ key: `c:${c.id}`, kind: c.icon, title: c.title, sub: c.sub, keys: comboOf(c.id, shortcuts) || undefined, run: () => c.run(actions) });
    const goalRow = (g: (typeof goals)[number]): Row => ({ key: `g:${g.id}`, kind: "goal", title: g.title, sub: goalLabel(g), hint: t("tasks.goals"), run: () => (postIntent({ to: "tasks", view: g.kind === "month" ? "month" : "year" }), actions.view("tasks")) });
    const taskRow = (x: (typeof tasks)[number]): Row => ({ key: `k:${x.id}`, kind: "task", title: x.title, sub: [x.plan, x.done ? t("list.done") : ""].filter(Boolean).join(" · ") || undefined, run: () => onOpenTask(x.id) });
    const tagRow = (x: TagInfo): Row => ({ key: `t:${x.tag}`, kind: "tag", title: x.tag, sub: t("pal.tagMeta", { n: x.count }), hint: t("pal.topicHint"), run: () => (postIntent({ to: "topic", tag: x.tag }), actions.view("notes")) });
    const bookRow = (b: BookRecord): Row => ({ key: `b:${b.id}`, kind: "book", title: b.title, sub: [b.author, t("pal.bookMeta", { pct: Math.round((b.progress ?? 0) * 100) })].filter(Boolean).join(" · "), hint: t("pal.open"), run: () => onOpenBook(b.id) });
    const recentBooks = [...books].filter((b) => b.lastOpenedAt > 0).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

    const textGroup = (): Group | null => {
      if (!textFound?.hits.length) return null;
      const byBook = new Map(books.map((b) => [b.id, b]));
      const seen = new Set<string>();
      return {
        title: t("pal.bookText"),
        rows: textFound.hits.flatMap((h, i) => {
          const b = byBook.get(h.bookId);
          if (!b) return [];
          const first = !seen.has(h.bookId);
          seen.add(h.bookId);
          return [{ key: `x:${h.bookId}:${i}`, kind: "text" as const, title: h.snippet, sub: [b.title, h.section > 0 || b.format === "pdf" ? t(b.format === "pdf" ? "th.page" : "th.section", { n: h.section + 1 }) : "", first && h.count > 1 ? t("th.count", { n: h.count }) : ""].filter(Boolean).join(" · "), hint: t("pal.open"), run: () => onOpenBookAt(h.bookId, { section: h.section, text: text.trim(), snippet: h.snippet }) }];
        }),
      };
    };

    if (scope === "text") {
      const g = textGroup();
      if (g) out.push(g);
    } else if (scope === "tag") {
      const rows = pick(tags, q, (x) => x.tag).sort((a, b) => (q ? 0 : b.count - a.count));
      out.push({ title: t("pal.tags"), rows: rows.slice(0, 30).map(tagRow) });
    } else if (scope === "book") {
      const rows = pick(q ? books : recentBooks.length ? recentBooks : books, q, (b) => b.title, (b) => b.author);
      out.push({ title: t("pal.books"), rows: rows.slice(0, 30).map(bookRow) });
    } else if (scope === "cmd") {
      out.push({ title: t("pal.cmds"), rows: pick(cmds, q, (c) => c.title, (c) => c.words).slice(0, 40).map(cmdRow) });
    } else if (!q) {
      const rec: Row[] = [];
      for (const k of loadRecent()) {
        const id = k.slice(2);
        const r = k.startsWith("t:") ? tags.filter((x) => x.tag === id).map(tagRow)[0] : k.startsWith("b:") ? books.filter((b) => b.id === id).map(bookRow)[0] : k.startsWith("k:") ? tasks.filter((x) => x.id === id).map(taskRow)[0] : k.startsWith("g:") ? goals.filter((g) => g.id === id).map(goalRow)[0] : undefined;
        if (r) rec.push(r);
      }
      const recentRows = rec.length ? rec.slice(0, 5) : recentBooks.slice(0, 3).map(bookRow);
      if (recentRows.length) out.push({ title: t("pal.recent"), rows: recentRows });
      out.push({ title: t("pal.common"), rows: cmds.filter((c) => c.common).map(cmdRow) });
    } else {
      const tg = pick(tags, q, (x) => x.tag).slice(0, CAP);
      if (tg.length) out.push({ title: t("pal.tags"), rows: tg.map(tagRow) });
      const bk = pick(books, q, (b) => b.title, (b) => b.author).filter((b) => rank(b.title, q) >= 0 || rank(b.author ?? "", q) >= 0).slice(0, CAP);
      if (bk.length) out.push({ title: t("pal.books"), rows: bk.map(bookRow) });
      if (noteHits.length) {
        const byBook = new Map(books.map((b) => [b.id, b.title]));
        out.push({
          title: t("pal.notes"),
          rows: noteHits.map((h) => ({
            key: `n:${h.note.id}`,
            kind: "note" as const,
            title: notePreview(h.note, 90),
            sub: t("pal.noteMeta", { src: isFreeNote(h.note) ? t("hub.free") : docLabel(byBook.get(h.bookId), h.note), when: relTime(h.note.createdAt) }),
            run: () => {
              if (isFreeNote(h.note)) (postIntent({ to: "find", q: text.trim() }), actions.view("notes"));
              else onOpenNote(h);
            },
          })),
        });
      }
      const tk = tasks.filter((x) => x.title.toLowerCase().includes(q)).sort((a, b) => Number(a.done) - Number(b.done)).slice(0, CAP);
      if (tk.length) out.push({ title: t("pal.tasks"), rows: tk.map(taskRow) });
      const gl = goals.filter((g) => g.title.toLowerCase().includes(q)).slice(0, CAP);
      if (gl.length) out.push({ title: t("tasks.goals"), rows: gl.map(goalRow) });
      const cm = pick(cmds, q, (c) => c.title, (c) => c.words).slice(0, CAP);
      if (cm.length) out.push({ title: t("pal.cmds"), rows: cm.map(cmdRow) });
      const tg2 = textGroup();
      if (tg2) out.push(tg2);
      if (!out.length) {
        out.push({
          title: t("pal.none", { q: text.trim() }),
          rows: [{ key: "make", kind: "cmd", title: t("pal.makeNote", { q: text.trim() }), hint: "↵", run: () => void makeNote(text.trim()) }],
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, q, tags, books, tasks, goals, noteHits, cmds, shortcuts, textFound]);

  const makeNote = async (body: string) => {
    const now = Date.now();
    const a: Annotation = { id: crypto.randomUUID(), anchor: DOC_ANCHOR, color: "amber", style: "none", note: body, tags: parseTags(body), side: "right", kind: "free", createdAt: now, updatedAt: now };
    try {
      await notesStore.add(FREE_BOOK, a);
      notify(t("pal.noteSaved"));
    } catch (e) {
      notify(String(e));
    }
  };

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => setSel(0), [scope, q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".pal-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, groups]);

  if (!open) return null;
  const run = (r?: Row) => {
    if (!r) return;
    close();
    if (/^[tbkg]:/.test(r.key)) saveRecent(r.key);
    r.run();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[sel]);
    } else if (e.key === "Backspace" && !text && scope) {
      e.preventDefault();
      setScope(null);
    } else if (!text && !scope && PREFIX[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setScope(PREFIX[e.key]);
    }
  };

  const scopeName = scope === "tag" ? t("pal.scopeTag") : scope === "book" ? t("pal.scopeBook") : scope === "cmd" ? t("pal.scopeCmd") : scope === "text" ? t("pal.scopeText") : "";
  let n = -1;
  return (
    <div className="pal-wrap" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label={t("pal.ph")}>
        <div className="pal-in">
          <Search size={21} />
          {scope && <span className="pal-scope">{scopeName}</span>}
          <input ref={input} id="palette-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={t("pal.ph")} spellCheck={false} autoComplete="off" />
        </div>
        {groups.length > 0 && (
          <div className="pal-list" ref={listRef}>
            {groups.map((g) => (
              <Fragment key={g.title}>
                <div className="pal-grp">
                  <span>{g.title}</span>
                  {g.title === t("pal.notes") && <span>{t("pal.count", { n: noteHits.length })}</span>}
                </div>
                {g.rows.map((r) => {
                  n++;
                  const idx = n;
                  return (
                    <div key={r.key} className={`pal-row ${idx === sel ? "sel" : ""}`} onMouseMove={() => idx !== sel && setSel(idx)} onClick={() => run(r)}>
                      <span className={`pal-ic ${r.kind}`}>{ICON[r.kind]}</span>
                      <span className="pal-t">
                        <Hl text={r.title} q={q} />
                        {r.sub && <small>{r.sub}</small>}
                      </span>
                      {r.keys ? (
                        <span className="pal-keys">
                          {chips(r.keys).map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </span>
                      ) : (
                        r.hint && <span className="pal-hint">{r.hint}</span>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        )}
        <div className="pal-foot">
          <span>
            <kbd>#</kbd> {t("pal.keyTag")}
          </span>
          <span>
            <kbd>@</kbd> {t("pal.keyBook")}
          </span>
          <span>
            <kbd>/</kbd> {t("pal.keyCmd")}
          </span>
          <span>
            <kbd>~</kbd> {t("pal.keyText")}
          </span>
          <span className="r">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("pal.pick")} <kbd>↵</kbd> {t("pal.open")}
          </span>
        </div>
      </div>
    </div>
  );
}
