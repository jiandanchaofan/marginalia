import { useEffect, useMemo, useState } from "react";
import { SOURCE_LIMIT, SourceList } from "./SourceList";
import { docTitle } from "../host/registry";
import { isVirtualDoc } from "../host/virtualDoc";
import { BookOpen, ChevronRight, FileText, Hash, Library as LibraryIcon, Network, NotebookPen, Pencil, Pin, PinOff, SlidersHorizontal, Sparkles, Star, Tags, Trash2, X } from "lucide-react";
import { FREE_BOOK, isFreeNote, type BookRecord } from "../core/types";
import { notesStore, useNotesVersion, type NoteHit, type TagInfo } from "../notes/store";
import { buildTree, normalizeTag, type TagNode } from "../notes/tags";
import { confirmDialog, loadJson, saveJson } from "../platform";
import { describeFilter } from "../notes/query";
import { NoteReview, useDueCount } from "../review/NoteReview";
import type { Theme } from "../settings";
import { EMPTY_FILTER, NotesBrowser, type NotesFilter } from "./NotesBrowser";
import { DocTypeBadge, docType } from "./DocTypeBadge";
import { Heatmap } from "./Heatmap";
import { MemoComposer } from "./MemoComposer";
import { NoteGraph } from "./NoteGraph";
import { t } from "../i18n";
import { TopicPage } from "../topic/TopicPage";
import { TopicsOverview } from "../topic/TopicsOverview";
import { TrashPage } from "../trash/TrashPage";
import { useTrash } from "../trash/store";
import { useIntent } from "../palette/useIntent";

export const kindOf = (b: BookRecord): "book" | "article" => (b.format === "md" || b.format === "html" ? "article" : "book");

interface Props {
  books: BookRecord[];
  counts: Record<string, number>;
  theme: Theme;
  onOpenNote(hit: NoteHit): void;
  onOpenBook(id: string): void;
  notify(msg: string): void;
}

type Source = { type: "all" } | { type: "kind"; kind: "book" | "article" } | { type: "book"; id: string } | { type: "free" };

interface SavedFilter {
  id: string;
  name: string;
  filter: NotesFilter;
  source: Source;
}
const SAVED_FILE = "saved_filters.json";

export function NotesHub({ books, counts, theme, onOpenNote, onOpenBook, notify }: Props) {
  const version = useNotesVersion();
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [filter, setFilter] = useState<NotesFilter>(EMPTY_FILTER);
  const [source, setSource] = useState<Source>({ type: "all" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [mode, setMode] = useState<"notes" | "review" | "graph" | "topic" | "topics" | "trash">("notes");
  const trashCount = useTrash().filter((e) => e.kind === "note").length;
  const [fromOverview, setFromOverview] = useState(false);
  const dueCount = useDueCount();
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [naming, setNaming] = useState<string | null>(null); // draft name while saving a filter

  useEffect(() => {
    loadJson<SavedFilter[]>(SAVED_FILE, []).then(setSaved);
  }, []);
  const persistSaved = (list: SavedFilter[]) => {
    setSaved(list);
    saveJson(SAVED_FILE, list).catch((e) => notify(t("hub.saveFail", { err: String(e) })));
  };

  useEffect(() => {
    notesStore.tags().then(setTags);
  }, [version]);

  // the command palette sends us to a view, a topic, a search or the note box
  useIntent(
    (i) => i.to === "hub" || i.to === "topic" || i.to === "find",
    (i) => {
      setDrawer(false);
      if (i.to === "hub") {
        if (i.mode === "review" || i.mode === "graph" || i.mode === "topics" || i.mode === "trash") return setMode(i.mode);
        setMode("notes");
        setFilter({ ...EMPTY_FILTER });
        setSource(i.mode === "all" ? { type: "all" } : i.mode === "free" ? { type: "free" } : { type: "kind", kind: i.mode === "books" ? "book" : "article" });
      } else if (i.to === "topic") {
        setSource({ type: "all" });
        setFilter({ ...EMPTY_FILTER, tags: [i.tag] });
        setFromOverview(false);
        setMode("topic");
      } else if (i.to === "find") {
        setSource({ type: "all" });
        setFilter({ ...EMPTY_FILTER, q: i.q });
        setMode("notes");
      }
    },
  );

  const bookMap = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const tree = useMemo(() => buildTree(tags), [tags]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Source selection → bookIds filter.
  useEffect(() => {
    const ids =
      source.type === "all"
        ? undefined
        : source.type === "book"
          ? [source.id]
          : source.type === "free"
            ? [FREE_BOOK]
            : books.filter((b) => kindOf(b) === source.kind).map((b) => b.id);
    setFilter((f) => ({ ...f, bookIds: ids }));
  }, [source, books]);

  const sourceLabel = source.type === "kind" ? (source.kind === "book" ? t("hub.books") : t("hub.articles")) : source.type === "free" ? t("hub.free") : undefined;
  const commitSaved = () => {
    const name = naming?.trim();
    setNaming(null);
    if (!name) return;
    persistSaved([...saved, { id: `${Date.now()}`, name, filter: { ...filter }, source }]);
    notify(t("hub.savedFilter", { name }));
  };
  const applySaved = (s: SavedFilter) => {
    setMode("notes");
    setSource(s.source);
    setFilter(s.filter);
    setDrawer(false);
  };

  const selectTag = (tag: string, multi: boolean) => {
    setMode(mode === "topic" && !multi ? "topic" : "notes");
    setFilter((f) => ({
      ...f,
      tags: multi ? (f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag]) : f.tags.length === 1 && f.tags[0] === tag ? [] : [tag],
    }));
  };

  const rename = async (from: string, raw: string) => {
    setRenaming(null);
    const to = normalizeTag(raw.replace(/^#/, ""));
    if (!to || to === from) return;
    const merging = tags.some((t) => t.tag === to);
    try {
      const n = await notesStore.renameTag(from, to);
      notify(t(merging ? "hub.merged" : "hub.renamed", { to, n }));
      setFilter((f) => ({ ...f, tags: f.tags.map((t) => (t === from || t.startsWith(`${from}/`) ? to + t.slice(from.length) : t)) }));
    } catch (e) {
      notify(String(e));
    }
  };
  const remove = async (tag: string) => {
    if (!(await confirmDialog(t("hub.removeTagConfirm", { tag })))) return;
    const n = await notesStore.deleteTag(tag);
    notify(t("hub.removedTag", { n, tag }));
    setFilter((f) => ({ ...f, tags: f.tags.filter((t) => t !== tag && !t.startsWith(`${tag}/`)) }));
  };

  const renderNode = (n: TagNode, depth: number): React.ReactNode => {
    const expanded = open.has(n.tag);
    const selected = filter.tags.includes(n.tag);
    return (
      <div key={n.tag}>
        <div className={`tree-row ${selected ? "on" : ""}`} style={{ paddingLeft: 6 + depth * 14 }}>
          <button
            className={`tree-twisty ${n.children.length ? "" : "leaf"} ${expanded ? "open" : ""}`}
            onClick={() =>
              setOpen((s) => {
                const next = new Set(s);
                if (next.has(n.tag)) next.delete(n.tag);
                else next.add(n.tag);
                return next;
              })
            }
          >
            {n.children.length > 0 && <ChevronRight size={13} />}
          </button>
          {renaming === n.tag ? (
            <input
              className="tree-rename"
              autoFocus
              defaultValue={n.tag}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(n.tag, (e.target as HTMLInputElement).value);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => rename(n.tag, e.target.value)}
            />
          ) : (
            <button className="tree-label" onClick={(e) => selectTag(n.tag, e.ctrlKey || e.metaKey)} title={t("hub.tagTip", { tag: n.tag })}>
              {n.pinned ? <Pin size={12} className="tree-pin" /> : <Hash size={12} />}
              <span>{n.name}</span>
            </button>
          )}
          <span className="tree-count">{n.count}</span>
          <span className="tree-actions">
            <button title={n.pinned ? t("hub.unpin") : t("hub.pin")} onClick={() => notesStore.pinTag(n.tag, !n.pinned)}>
              {n.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button title={t("hub.rename")} onClick={() => setRenaming(n.tag)}>
              <Pencil size={12} />
            </button>
            <button title={t("hub.removeTag")} className="danger" onClick={() => remove(n.tag)}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {expanded && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const pickDay = (day: string | undefined) => {
    setMode("notes");
    setFilter((f) => ({ ...f, day }));
    setDrawer(false);
  };
  const openNote = (hit: NoteHit) => {
    if (!isFreeNote(hit.note)) onOpenNote(hit);
  };

  const bookCount = (kind: "book" | "article") => books.filter((b) => kindOf(b) === kind).reduce((s, b) => s + (counts[b.id] ?? 0), 0);
  const src = (s: Source, label: React.ReactNode, count: number, icon: React.ReactNode) => {
    const on = mode === "notes" && JSON.stringify(s) === JSON.stringify(source);
    return (
      <button
        key={JSON.stringify(s)}
        className={`side-item ${on ? "on" : ""}`}
        onClick={() => {
          setMode("notes");
          setSource(s);
        }}
      >
        {icon}
        <span className="side-label">{label}</span>
        <span className="tree-count">{count}</span>
      </button>
    );
  };

  const isOn = (id: string) => mode === "notes" && JSON.stringify({ type: "book", id }) === JSON.stringify(source);
  const sourceItems = [
    ...books
      .filter((b) => counts[b.id])
      .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0))
      .map((b) => ({ on: isOn(b.id), node: src({ type: "book", id: b.id }, b.title, counts[b.id] ?? 0, <DocTypeBadge type={docType(b)} inline size={15} />) })),
    ...Object.keys(counts)
      .filter((id) => !books.some((b) => b.id === id) && isVirtualDoc(id) && docTitle(id))
      .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
      .map((id) => ({ on: isOn(id), node: src({ type: "book", id }, docTitle(id), counts[id] ?? 0, <BookOpen size={14} />) })),
  ];

  const sidebar = (
    <aside className={`hub-side ${drawer ? "open" : ""}`}>
      <Heatmap selected={filter.day} onPick={pickDay} />
      <div className="side-section">
        {src({ type: "all" }, t("hub.all"), total, <LibraryIcon size={14} />)}
        <button className={`side-item review-entry ${mode === "graph" ? "on" : ""}`} onClick={() => (setMode("graph"), setDrawer(false))}>
          <Network size={14} />
          <span className="side-label">{t("hub.graph")}</span>
        </button>
        {src({ type: "free" }, t("hub.free"), counts[FREE_BOOK] ?? 0, <NotebookPen size={14} />)}
        {src({ type: "kind", kind: "book" }, t("hub.books"), bookCount("book"), <BookOpen size={14} />)}
        {src({ type: "kind", kind: "article" }, t("hub.articles"), bookCount("article"), <FileText size={14} />)}
        <button className={`side-item review-entry ${mode === "review" ? "on" : ""}`} onClick={() => (setMode("review"), setDrawer(false))}>
          <Sparkles size={14} />
          <span className="side-label">{t("hub.review")}</span>
          {dueCount > 0 && <span className="tree-count due-badge">{dueCount}</span>}
        </button>
        <button className={`side-item review-entry ${mode === "trash" ? "on" : ""}`} onClick={() => (setMode("trash"), setDrawer(false))}>
          <Trash2 size={14} />
          <span className="side-label">{t("tr.title")}</span>
          {trashCount > 0 && <span className="tree-count">{trashCount}</span>}
        </button>
      </div>
      {(saved.length > 0 || naming !== null) && (
        <>
          <div className="side-title">{t("hub.savedFilters")}</div>
          <div className="side-section">
            {naming !== null && (
              <div className="side-item editing">
                <Star size={13} />
                <input
                  className="tree-rename"
                  autoFocus
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitSaved();
                    if (e.key === "Escape") setNaming(null);
                  }}
                  onBlur={commitSaved}
                />
              </div>
            )}
            {saved.map((s) => (
              <div key={s.id} className="tree-row saved-row">
                <button className="tree-label" onClick={() => applySaved(s)} title={describeFilter(s.filter, bookMap)}>
                  <Star size={12} />
                  <span>{s.name}</span>
                </button>
                <span className="tree-actions">
                  <button title={t("hub.deleteSaved")} className="danger" onClick={() => persistSaved(saved.filter((x) => x.id !== s.id))}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="side-title tag-title">
        <span>{t("hub.tags")}</span>
        <button className={`topics-pill ${mode === "topics" || (mode === "topic" && fromOverview) ? "on" : ""}`} onClick={() => (setMode("topics"), setDrawer(false))}>
          <Tags size={12} /> {t("tpo.title")}
        </button>
      </div>
      <div className="side-section tree">{tree.length ? tree.map((n) => renderNode(n, 0)) : <div className="side-empty">{t("hub.tagsEmpty")}</div>}</div>
      <div className="side-title">{t("hub.sources")}</div>
      <div className="side-section">
        <SourceList limit={SOURCE_LIMIT} activeIndex={sourceItems.findIndex((x) => x.on)} items={sourceItems.map((x) => x.node)} more={(n) => t("hub.moreSources", { n })} less={t("hub.lessSources")} />
      </div>
    </aside>
  );

  return (
    <div className="hub">
      {sidebar}
      {drawer && <div className="hub-scrim" onClick={() => setDrawer(false)} />}
      <section className="hub-main">
        {mode === "graph" ? (
          <NoteGraph
            books={bookMap}
            theme={theme}
            onOpenNote={onOpenNote}
            notify={notify}
            headerExtra={
              <button className="icon-btn hub-drawer-btn" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
                <SlidersHorizontal size={17} />
              </button>
            }
          />
        ) : mode === "trash" ? (
          <>
            <button className="icon-btn hub-drawer-btn review-drawer" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
            <TrashPage kind="note" books={bookMap} />
          </>
        ) : mode === "topics" ? (
          <>
            <button className="icon-btn hub-drawer-btn review-drawer" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
            <TopicsOverview onOpen={(tag) => (setFromOverview(true), setFilter((f) => ({ ...f, tags: [tag] })), setMode("topic"))} />
          </>
        ) : mode === "topic" && filter.tags.length === 1 ? (
          <>
            <button className="icon-btn hub-drawer-btn review-drawer" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
            <TopicPage tag={filter.tags[0]} books={bookMap} theme={theme} onOpenNote={onOpenNote} onOpenBook={onOpenBook} onPickTag={(x) => setFilter((f) => ({ ...f, tags: [x] }))} onBack={() => setMode(fromOverview ? "topics" : "notes")} />
          </>
        ) : mode === "review" ? (
          <>
            <button className="icon-btn hub-drawer-btn review-drawer" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
            <NoteReview books={bookMap} theme={theme} onOpenNote={onOpenNote} notify={notify} />
          </>
        ) : (
          <>
          {filter.tags.length === 1 && (
            <button className="tp-open" onClick={() => (setFromOverview(false), setMode("topic"))}>
              {t("tp.open")} · #{filter.tags[0]} →
            </button>
          )}
          <MemoComposer prefillTags={filter.tags} notify={notify} />
          <NotesBrowser
            theme={theme}
            filter={filter}
            onFilter={setFilter}
            books={bookMap}
            batch
            notify={notify}
            exportHeading={t("hub.exportTitle", { what: describeFilter(filter, bookMap, sourceLabel) })}
            onSaveFilter={() => (setNaming(describeFilter(filter, bookMap, sourceLabel)), setDrawer(true))}
            onOpen={openNote}
            headerExtra={
              <button className="icon-btn hub-drawer-btn" title={t("hub.drawer")} onClick={() => setDrawer((d) => !d)}>
                {drawer ? <X size={18} /> : <SlidersHorizontal size={17} />}
              </button>
            }
          />
          </>
        )}
      </section>
    </div>
  );
}
