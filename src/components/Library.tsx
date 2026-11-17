import { themeClass } from "../settings";
import { useEffect, useMemo, useState } from "react";
import { BookMarked, BookOpen, CheckSquare, Compass, FilePlus2, Layers, LayoutGrid, List, Pencil, Search, Settings as SettingsIcon, Square, StickyNote, Tags, Trash2, X, ListChecks } from "lucide-react";
import { STATUS_LABEL, readStatus, type BookRecord, type ReadStatus } from "../core/types";
import type { Theme } from "../settings";
import type { NoteHit } from "../notes/store";
import { Tasks } from "./Tasks";
import { useTasks } from "../tasks/useTasks";
import { TextHits, type TextTarget } from "../search/TextHits";
import { dueCount } from "../tasks/query";
import { NotesHub, kindOf } from "./NotesHub";
import { Inbox } from "./Inbox";
import { feedsApi, interestCounts, useFeedsVersion, type FeedItem } from "../feeds/api";
import { InterestChip } from "./InterestPicker";
import { InterestDialog } from "./InterestDialog";
import { BookInfoDialog } from "./BookInfoDialog";
import { BatchTagDialog } from "./BatchTagDialog";
import { DOC_TYPES, DocTypeBadge, docType } from "./DocTypeBadge";
import { useImage } from "../notes/images";
import { docTitle, pageItems, useRegistry } from "../host/registry";
import { isVirtualDoc } from "../host/virtualDoc";
import { PageHost } from "../host/SlotHost";
import { recentDocs } from "../host/virtualState";
import { applyPlan, onTasksChanged, planProgress, removePlan } from "../host/plans";
import type { PageContext } from "../host/sdk";
import { fmtDate, t } from "../i18n";
import { ReadingHeat } from "../reading/ReadingHeat";
import { AppLogo } from "./AppLogo";

/** Pseudo-interest used by the 未分类 chip. */
const NONE = "\u0000none";

/** The cover picture of an EPUB; until it loads (or if it cannot) the coloured cover shows through. */
function CoverImg({ id }: { id: string }) {
  const { url } = useImage(id);
  return url ? <img className="cover-img" src={url} alt="" draggable={false} /> : null;
}

/** What a module's page can do in the app. */
const pageCtx: PageContext = {
  openDoc: (docId, title) => window.dispatchEvent(new CustomEvent("reader:open-doc", { detail: { docId, title } })),
  recent: recentDocs,
  applyPlan,
  removePlan,
  planProgress,
  onTasksChanged,
};

type ShelfMode = "cover" | "list";
const MODE_KEY = "reader:shelf-mode";
const loadMode = (): ShelfMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "list" ? "list" : "cover";
  } catch {
    return "cover";
  }
};

const FORMAT_LABEL: Record<string, string> = { epub: "EPUB", pdf: "PDF", txt: "TXT", md: "Markdown", html: "Web" };

const ago = (ts: number) => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return t("time.justNow");
  if (d < 3600) return t("time.minAgo", { n: Math.floor(d / 60) });
  if (d < 86400) return t("time.hourAgo", { n: Math.floor(d / 3600) });
  if (d < 86400 * 30) return t("time.dayAgo", { n: Math.floor(d / 86400) });
  return fmtDate(ts);
};

/** Five-star mark: filled for the rating, faint for the rest. */
function Stars({ n }: { n: number }) {
  return (
    <span className="mini-stars" title={t("unit.stars", { n })}>
      {"★".repeat(n)}
      <i>{"★".repeat(5 - n)}</i>
    </span>
  );
}

interface Props {
  books: BookRecord[];
  counts: Record<string, number>;
  /** Books that have whole-document notes, with how many. */
  docCounts: Record<string, number>;
  /** "shelf" | "feeds" | "notes" | "tasks", or "page:<id>" for a page a module provides. */
  view: string;
  onView(v: string): void;
  unread: number;
  feedProgress: { done: number; total: number } | null;
  lastFeedRefresh: number | null;
  onRefreshFeeds(): void;
  onSaveFeedItem(item: FeedItem, sourceTitle?: string, interests?: string[]): Promise<string | null>;
  onUpdateBook(id: string, patch: Partial<BookRecord>): void;
  onOpenBookId(id: string): void;
  /** Open a book at a passage found in its text. */
  onOpenBookAt(id: string, target: TextTarget): void;
  bookSearch?: boolean;
  onOpenNote(hit: NoteHit): void;
  notify(msg: string): void;
  onClip(): void;
  onSettings(): void;
  theme: Theme;
  busy: boolean;
  /** 0–100 while a big file is being copied into the library. */
  importPct?: number | null;
  onImport(): void;
  onOpen(b: BookRecord): void;
  onRemove(b: BookRecord): void;
}

export function Library(props: Props) {
  const { books, counts, docCounts, view, onView, onOpenNote, notify, onClip, theme, busy, onImport, onOpen, onRemove } = props;
  useRegistry();
  const pages = pageItems();
  const modulePage = pages.find((pg) => view === `page:${pg.id}`);
  const bookMap = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const due = dueCount(useTasks()); // the number on the 任务 tab: today's and overdue tasks
  const [kind, setKind] = useState<"all" | "book" | "article">("all");
  const [status, setStatus] = useState<ReadStatus | "all">("all");
  const [picked, setPicked] = useState<string[]>([]); // selected interest filters (any-of; NONE = 未分类)
  const [grouped, setGrouped] = useState(false);
  const [mode, setModeState] = useState<ShelfMode>(loadMode);
  const setMode = (m: ShelfMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };
  const [editing, setEditing] = useState<string | null>(null); // book id whose interests are being edited
  const [renaming, setRenaming] = useState<string | null>(null); // book id whose name / remark is being edited
  const [query, setQuery] = useState("");
  // batch selection (shelf tagging)
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSel, setLastSel] = useState<string | null>(null);
  const [batchDlg, setBatchDlg] = useState<"add" | "remove" | null>(null);
  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setLastSel(null);
    setBatchDlg(null);
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !batchDlg && exitSelecting();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, batchDlg]); // eslint-disable-line react-hooks/exhaustive-deps

  // One vocabulary for subscriptions and the shelf.
  const feedsVersion = useFeedsVersion();
  const [feedInterests, setFeedInterests] = useState<string[]>([]);
  useEffect(() => {
    feedsApi
      .sources()
      .then((l) => setFeedInterests(interestCounts(l).map((i) => i.name)))
      .catch(() => {});
  }, [feedsVersion]);
  const bookInterests = useMemo(() => interestCounts(books.map((b) => ({ interests: b.interests ?? [] }) as never)), [books]);
  const vocabulary = useMemo(() => [...new Set([...bookInterests.map((i) => i.name), ...feedInterests])], [bookInterests, feedInterests]);
  const uncategorized = books.filter((b) => !b.interests?.length).length;
  // A removed interest can't stay selected.
  useEffect(() => {
    setPicked((cur) => (cur.every((t) => t === NONE || bookInterests.some((i) => i.name === t)) ? cur : cur.filter((t) => t === NONE || bookInterests.some((i) => i.name === t))));
  }, [bookInterests]);

  const all = [...books].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  // the three most recently opened books or articles, for "continue reading"
  const recents = all.filter((b) => b.lastOpenedAt > 0).slice(0, 3);
  const matchesInterest = (b: BookRecord) =>
    !picked.length || picked.some((t) => (t === NONE ? !b.interests?.length : (b.interests ?? []).includes(t)));
  const q = query.trim().toLowerCase();
  const matchesQuery = (b: BookRecord) =>
    !q || [b.title, b.author, b.siteName, b.remark, ...(b.interests ?? [])].some((x) => x && x.toLowerCase().includes(q));
  const sorted = all.filter((b) => (kind === "all" || kindOf(b) === kind) && (status === "all" || readStatus(b) === status) && matchesInterest(b) && matchesQuery(b));
  /** Click in selection mode: toggle one item; with Shift, select everything between the last click and this one. */
  const toggleSel = (b: BookRecord, shift: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (shift && lastSel) {
        const i = sorted.findIndex((x) => x.id === lastSel);
        const j = sorted.findIndex((x) => x.id === b.id);
        if (i >= 0 && j >= 0) {
          for (const x of sorted.slice(Math.min(i, j), Math.max(i, j) + 1)) next.add(x.id);
          return next;
        }
      }
      if (next.has(b.id)) next.delete(b.id);
      else next.add(b.id);
      return next;
    });
    setLastSel(b.id);
  };
  const chosenBooks = books.filter((b) => selected.has(b.id));
  const addTags = (tags: string[]) => {
    for (const b of chosenBooks) props.onUpdateBook(b.id, { interests: [...new Set([...(b.interests ?? []), ...tags])] });
    notify(t("shelf.batch.added", { n: chosenBooks.length, tags: tags.join(t("shelf.sep")) }));
  };
  const removeTags = (tags: string[]) => {
    for (const b of chosenBooks) {
      const rest = (b.interests ?? []).filter((t) => !tags.includes(t));
      props.onUpdateBook(b.id, { interests: rest.length ? rest : undefined });
    }
    notify(t("shelf.batch.removed", { n: chosenBooks.length, tags: tags.join(t("shelf.sep")) }));
  };
  const setStatusOf = (s: ReadStatus | undefined) => {
    for (const b of chosenBooks) props.onUpdateBook(b.id, { status: s });
    notify(s ? t("shelf.batch.setStatus", { n: chosenBooks.length, status: STATUS_LABEL[s] }) : t("shelf.batch.autoStatus", { n: chosenBooks.length }));
  };
  const carriedTags = [...new Set(chosenBooks.flatMap((b) => b.interests ?? []))];

  const togglePick = (t: string) => setPicked((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const editingBook = editing ? books.find((b) => b.id === editing) : null;
  const renamingBook = renaming ? books.find((b) => b.id === renaming) : null;

  /** Sections for 按兴趣分组: a book appears under each of its interests (or 未分类). */
  const groups = useMemo(() => {
    if (!grouped) return null;
    const m = new Map<string, BookRecord[]>();
    for (const b of sorted) for (const t of b.interests?.length ? b.interests : [NONE]) (m.get(t) ?? m.set(t, []).get(t)!).push(b);
    return [...m].sort(([a, x], [b, y]) => (a === NONE ? 1 : b === NONE ? -1 : y.length - x.length || a.localeCompare(b, "zh-CN")));
  }, [grouped, sorted]);
  const statusCount = (s: ReadStatus) => books.filter((b) => readStatus(b) === s).length;
  const nArticles = books.filter((b) => kindOf(b) === "article").length;
  const noteCount = (b: BookRecord) => counts[b.id] ?? 0;

  /** List mode: a compact one-row card; the grid around it decides how many columns fit. */
  const renderRow = (b: BookRecord, keyPrefix = "") => {
    const type = docType(b);
    const { from, to, label } = DOC_TYPES[type];
    const tags = b.interests ?? [];
    const st = readStatus(b);
    return (
      <div key={keyPrefix + b.id} className={`row-item ${selecting && selected.has(b.id) ? "selected" : ""}`} onClick={(e) => (selecting ? toggleSel(b, e.shiftKey) : onOpen(b))}>
        {selecting && <span className="sel-check">{selected.has(b.id) ? <CheckSquare size={18} /> : <Square size={18} />}</span>}
        <span className="row-type" style={{ background: `linear-gradient(155deg, ${from}, ${to})` }}>
          <DocTypeBadge type={type} inline size={20} />
        </span>
        <div className="row-body">
          <div className="row-line">
            <span className="row-title" title={b.title}>
              {b.title}
            </span>
            {docCounts[b.id] > 0 && (
              <span className="row-note-mark" title={t("shelf.noteMark", { n: docCounts[b.id] })}>
                <StickyNote size={12} />
              </span>
            )}
            <span className="row-flags">
              {st && <em className={`st-${st}`}>{STATUS_LABEL[st]}</em>}
              {!!b.rating && <Stars n={b.rating} />}
            </span>
          </div>
          {b.remark && (
            <div className="row-remark" title={b.remark}>
              {b.remark}
            </div>
          )}
          <div className="row-line sub">
            <span className="row-sub">
              {[b.sourceUrl ? b.siteName || label : b.author || label, noteCount(b) ? t("unit.notes", { n: noteCount(b) }) : "", ago(b.lastOpenedAt)].filter(Boolean).join(" · ")}
            </span>
            <span className="row-tags">
              {tags.slice(0, 2).map((t) => (
                <InterestChip key={t} name={t} small />
              ))}
              {tags.length > 2 && <span className="more">+{tags.length - 2}</span>}
            </span>
          </div>
        </div>
        {b.progress > 0 && <i className="row-progress" style={{ width: `${Math.round(b.progress * 100)}%` }} />}
        <span className="row-actions">
          <button
            title={t("shelf.rename")}
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(b.id);
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            title={t("shelf.interests")}
            onClick={(e) => {
              e.stopPropagation();
              setEditing(b.id);
            }}
          >
            <Tags size={14} />
          </button>
          <button
            title={t("shelf.remove")}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(b);
            }}
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>
    );
  };

  const renderItem = (b: BookRecord, keyPrefix = "") => (mode === "list" ? renderRow(b, keyPrefix) : renderBook(b, keyPrefix));
  const gridClass = mode === "list" ? "lib-list" : "lib-grid";

  const renderBook = (b: BookRecord, keyPrefix = "") => {
    const type = docType(b);
    const { from, to } = DOC_TYPES[type];
    const tags = b.interests ?? [];
    return (
      <div key={keyPrefix + b.id} className={`book ${selecting && selected.has(b.id) ? "selected" : ""}`} onClick={(e) => (selecting ? toggleSel(b, e.shiftKey) : onOpen(b))}>
        {selecting && <span className="sel-check">{selected.has(b.id) ? <CheckSquare size={20} /> : <Square size={20} />}</span>}
        <div className={`cover ${b.sourceUrl ? "web" : ""} ${b.coverId ? "has-img" : ""}`} style={{ background: `linear-gradient(155deg, ${from}, ${to})` }}>
          {b.coverId && <CoverImg id={b.coverId} />}
          <span className="cover-format">{b.sourceUrl ? b.siteName || t("doctype.web") : (FORMAT_LABEL[b.format] ?? b.format)}</span>
          <DocTypeBadge type={type} />
          {docCounts[b.id] > 0 && (
            <span className="cover-doc" title={t("shelf.noteMark", { n: docCounts[b.id] })}>
              <StickyNote size={13} />
            </span>
          )}
          <span className="cover-title">{b.title}</span>
          {b.sourceUrl && b.excerpt && <span className="cover-excerpt">{b.excerpt}</span>}
          {b.author && <span className="cover-author">{b.author}</span>}
          {b.progress > 0 && (
            <span className="cover-progress">
              <i style={{ width: `${Math.round(b.progress * 100)}%` }} />
            </span>
          )}
          <button
            className="book-edit"
            title={t("shelf.rename")}
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(b.id);
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            className="book-tag"
            title={t("shelf.interests")}
            onClick={(e) => {
              e.stopPropagation();
              setEditing(b.id);
            }}
          >
            <Tags size={14} />
          </button>
          <button
            className="book-remove"
            title={t("shelf.remove")}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(b);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        <div className="book-meta">
          <span className="book-title">{b.title}</span>
          {tags.length > 0 && (
            <span className="book-interests">
              {tags.slice(0, 2).map((t) => (
                <InterestChip key={t} name={t} small />
              ))}
              {tags.length > 2 && <span className="more">+{tags.length - 2}</span>}
            </span>
          )}
          {(readStatus(b) || !!b.rating) && (
            <span className="book-flags">
              {readStatus(b) && <em className={`st-${readStatus(b)}`}>{STATUS_LABEL[readStatus(b)!]}</em>}
              {!!b.rating && <Stars n={b.rating} />}
            </span>
          )}
          {b.remark && (
            <span className="book-remark" title={b.remark}>
              {b.remark}
            </span>
          )}
          <span className="book-sub">
            {noteCount(b) ? `${t("unit.notes", { n: noteCount(b) })} · ` : ""}
            {ago(b.lastOpenedAt)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={`library ${themeClass(theme)} view-${view} ${selecting ? "shelf-selecting" : ""}`}>
      <header className="lib-header">
        <div className="brand">
          <AppLogo />
          <div>
            <div className="brand-name">{t("app.name")}</div>
            <div className="brand-sub">{t("about.slogan")}</div>
          </div>
        </div>
        <div className="segmented lib-switch">
          <button className={view === "notes" ? "on" : ""} onClick={() => onView("notes")}>
            <StickyNote size={15} /> {t("shelf.tab.notes")}
          </button>
          <button className={view === "shelf" ? "on" : ""} onClick={() => onView("shelf")}>
            <BookOpen size={15} /> {t("shelf.tab.shelf")}
          </button>
          <button className={view === "tasks" ? "on" : ""} onClick={() => onView("tasks")}>
            <ListChecks size={15} /> {t("shelf.tab.tasks")}{due > 0 && <span className="tab-badge">{due > 99 ? "99+" : due}</span>}
          </button>
          <button className={view === "feeds" ? "on" : ""} onClick={() => onView("feeds")}>
            <Compass size={15} /> {t("shelf.tab.explore")}{props.unread > 0 && <span className="tab-badge">{props.unread > 99 ? "99+" : props.unread}</span>}
          </button>
        </div>
        <div className="lib-actions">
          {pages.map((pg) => (
            <button key={pg.id} className={`module-tab ${view === `page:${pg.id}` ? "on" : ""}`} onClick={() => onView(`page:${pg.id}`)}>
              <BookMarked size={15} /> {pg.title}
            </button>
          ))}
          <button className="import-btn" onClick={onImport} disabled={busy}>
            <FilePlus2 size={16} /> {busy ? (props.importPct != null ? t("shelf.importingPct", { pct: props.importPct }) : t("shelf.importing")) : t("shelf.import")}
          </button>
          <button className="icon-btn" onClick={props.onSettings} title={t("shelf.settings")}>
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>

      {modulePage ? (
        <PageHost page={modulePage} ctx={pageCtx} />
      ) : view === "feeds" ? (
        <Inbox
          books={books}
          refreshing={props.feedProgress}
          lastRefresh={props.lastFeedRefresh}
          onRefresh={props.onRefreshFeeds}
          onSave={props.onSaveFeedItem}
          onOpenBook={props.onOpenBookId}
          onClip={onClip}
          notify={notify}
        />
      ) : view === "tasks" ? (
        <Tasks books={bookMap} notify={notify} onOpenNote={onOpenNote} />
      ) : view === "notes" ? (
        <NotesHub books={books} counts={counts} theme={theme} onOpenNote={onOpenNote} onOpenBook={(id) => { const b = books.find((x) => x.id === id); if (b) onOpen(b); else if (isVirtualDoc(id)) window.dispatchEvent(new CustomEvent("reader:open-doc", { detail: { docId: id, title: docTitle(id) || id } })); }} notify={notify} />
      ) : !books.length ? (
        <div className="lib-empty" onClick={onImport}>
          <BookOpen size={40} strokeWidth={1.2} />
          <h2>{t("shelf.empty.title")}</h2>
          <p>{t("shelf.empty.formats")}</p>
          <p>
            {t("shelf.empty.web", { key: "Ctrl + V" })}
          </p>
        </div>
      ) : (
        <>
          <div className="shelf-top">
          <ReadingHeat />
          {recents.length > 0 && (
            <div className="continue">
              <span className="continue-label">{t("shelf.continue")}</span>
              {recents.map((b) => (
                <button key={b.id} className="continue-row" onClick={() => onOpen(b)}>
                  <span className="continue-title">{b.title}</span>
                  <span className="continue-bar">
                    <i style={{ width: `${Math.round(b.progress * 100)}%` }} />
                  </span>
                  <span className="continue-meta">
                    {Math.round(b.progress * 100)}% · {t("unit.notes", { n: noteCount(b) })} · {ago(b.lastOpenedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
          </div>
          {(
            <div className="shelf-filter">
              {nArticles > 0 &&
                (
                  [
                    ["all", t("shelf.kind.all", { n: books.length })],
                    ["book", t("shelf.kind.book", { n: books.length - nArticles })],
                    ["article", t("shelf.kind.article", { n: nArticles })],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={`filter-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                    {label}
                  </button>
                ))}
              {nArticles > 0 && (["want", "reading", "done"] as ReadStatus[]).some((s) => statusCount(s) > 0) && <span className="filter-sep" />}
              {(["want", "reading", "done"] as ReadStatus[]).map(
                (s) =>
                  statusCount(s) > 0 && (
                    <button key={s} className={`filter-chip ${status === s ? "on" : ""}`} onClick={() => setStatus(status === s ? "all" : s)}>
                      {STATUS_LABEL[s]} {statusCount(s)}
                    </button>
                  ),
              )}
              <span className="nb-spacer" />
              <label className="shelf-search">
                <Search size={13} />
                <input value={query} placeholder={t("shelf.search")} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))} />
                {query && (
                  <button onClick={() => setQuery("")} title={t("shelf.clearSearch")}>
                    <X size={12} />
                  </button>
                )}
              </label>
              <button className={`filter-chip ${selecting ? "on" : ""}`} onClick={() => (selecting ? exitSelecting() : setSelecting(true))} title={t("shelf.select.tip")}>
                <CheckSquare size={13} /> {t("shelf.select")}
              </button>
              <div className="segmented small view-switch" role="group" aria-label={t("shelf.view")}>
                <button className={mode === "cover" ? "on" : ""} onClick={() => setMode("cover")} title={t("shelf.view.cover.tip")}>
                  <LayoutGrid size={13} /> {t("shelf.view.cover")}
                </button>
                <button className={mode === "list" ? "on" : ""} onClick={() => setMode("list")} title={t("shelf.view.list.tip")}>
                  <List size={13} /> {t("shelf.view.list")}
                </button>
              </div>
            </div>
          )}
          {props.bookSearch !== false && q.length >= 2 && <TextHits query={query} books={books} onOpen={props.onOpenBookAt} />}
          {(bookInterests.length > 0 || vocabulary.length > 0) && (
            <div className="shelf-filter shelf-interests">
              <span className="shelf-filter-label">{t("shelf.interest")}</span>
              {bookInterests.map((i) => (
                <InterestChip key={i.name} name={i.name} on={picked.includes(i.name)} onClick={() => togglePick(i.name)} />
              ))}
              {bookInterests.length > 0 && uncategorized > 0 && (
                <button className={`filter-chip ${picked.includes(NONE) ? "on" : ""}`} onClick={() => togglePick(NONE)}>
                  {t("shelf.uncategorized", { n: uncategorized })}
                </button>
              )}
              {picked.length > 0 && (
                <button className="link" onClick={() => setPicked([])}>
                  {t("common.clear")}
                </button>
              )}
              <span className="nb-spacer" />
              <button className={`filter-chip ${grouped ? "on" : ""}`} onClick={() => setGrouped((g) => !g)} title={t("shelf.group.tip")}>
                <Layers size={13} /> {t("shelf.group")}
              </button>
            </div>
          )}
          {bookInterests.length === 0 && (
            <div className="shelf-hint">
              <Tags size={13} /> {t("shelf.hint")}
            </div>
          )}
          {!sorted.length && <div className="nb-empty">{t("shelf.noMatch")}</div>}
          {groups ? (
            groups.map(([tag, list]) => (
              <section key={tag} className="shelf-group">
                <h3>
                  {tag === NONE ? t("shelf.uncategorized.group") : <InterestChip name={tag} />}
                  <em>{list.length}</em>
                </h3>
                <div className={gridClass}>{list.map((b) => renderItem(b, `${tag}:`))}</div>
              </section>
            ))
          ) : (
            <div className={gridClass}>{sorted.map((b) => renderItem(b))}</div>
          )}
        </>
      )}
      {view === "shelf" && selecting && (
        <div className="shelf-batch">
          <span className="batch-count">{t("shelf.batch.picked", { n: selected.size })}</span>
          <button className="batch-btn" onClick={() => setSelected(new Set(sorted.map((b) => b.id)))} disabled={!sorted.length} title={t("shelf.batch.allTip")}>
            {t("shelf.batch.all", { n: sorted.length })}
          </button>
          <button className="batch-btn" onClick={() => setSelected(new Set())} disabled={!selected.size}>
            {t("shelf.batch.none")}
          </button>
          <span className="batch-sep" />
          <button className="batch-btn" onClick={() => setBatchDlg("add")} disabled={!selected.size}>
            <Tags size={14} /> {t("shelf.batch.addTags")}
          </button>
          <button className="batch-btn" onClick={() => setBatchDlg("remove")} disabled={!selected.size || !carriedTags.length}>
            {t("shelf.batch.removeTags")}
          </button>
          <span className="batch-sep" />
          {(["want", "reading", "done"] as ReadStatus[]).map((s) => (
            <button key={s} className="batch-btn" onClick={() => setStatusOf(s)} disabled={!selected.size}>
              {STATUS_LABEL[s]}
            </button>
          ))}
          <button className="batch-btn" onClick={() => setStatusOf(undefined)} disabled={!selected.size} title={t("shelf.batch.statusAutoTip")}>
            {t("shelf.batch.statusAuto")}
          </button>
          <span className="nb-spacer" />
          <button className="primary-btn small" onClick={exitSelecting}>
            {t("common.done")}
          </button>
        </div>
      )}
      {batchDlg && <BatchTagDialog mode={batchDlg} count={selected.size} all={batchDlg === "add" ? vocabulary : carriedTags} onApply={batchDlg === "add" ? addTags : removeTags} onClose={() => setBatchDlg(null)} />}
      {renamingBook && <BookInfoDialog key={renamingBook.id} book={renamingBook} onSave={(p) => props.onUpdateBook(renamingBook.id, p)} onClose={() => setRenaming(null)} />}
      {editingBook && (
        <InterestDialog
          title={editingBook.title}
          value={editingBook.interests ?? []}
          all={vocabulary}
          onChange={(v) => props.onUpdateBook(editingBook.id, { interests: v.length ? v : undefined })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
