import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, FileText, Hash, Library as LibraryIcon, NotebookPen, Pencil, Pin, PinOff, SlidersHorizontal, Sparkles, Star, Trash2, X } from "lucide-react";
import { FREE_BOOK, isFreeNote, type BookRecord } from "../core/types";
import { notesStore, useNotesVersion, type NoteHit, type TagInfo } from "../notes/store";
import { buildTree, normalizeTag, type TagNode } from "../notes/tags";
import { confirmDialog, loadJson, saveJson } from "../platform";
import { describeFilter } from "../notes/query";
import { Review } from "./Review";
import type { Theme } from "../settings";
import { EMPTY_FILTER, NotesBrowser, type NotesFilter } from "./NotesBrowser";
import { DocTypeBadge, docType } from "./DocTypeBadge";
import { Heatmap } from "./Heatmap";
import { MemoComposer } from "./MemoComposer";

export const kindOf = (b: BookRecord): "book" | "article" => (b.format === "md" || b.format === "html" ? "article" : "book");

interface Props {
  books: BookRecord[];
  counts: Record<string, number>;
  theme: Theme;
  onOpenNote(hit: NoteHit): void;
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

export function NotesHub({ books, counts, theme, onOpenNote, notify }: Props) {
  const version = useNotesVersion();
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [filter, setFilter] = useState<NotesFilter>(EMPTY_FILTER);
  const [source, setSource] = useState<Source>({ type: "all" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [mode, setMode] = useState<"notes" | "review">("notes");
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [naming, setNaming] = useState<string | null>(null); // draft name while saving a filter

  useEffect(() => {
    loadJson<SavedFilter[]>(SAVED_FILE, []).then(setSaved);
  }, []);
  const persistSaved = (list: SavedFilter[]) => {
    setSaved(list);
    saveJson(SAVED_FILE, list).catch((e) => notify(`保存失败：${e}`));
  };

  useEffect(() => {
    notesStore.tags().then(setTags);
  }, [version]);

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

  const sourceLabel = source.type === "kind" ? (source.kind === "book" ? "书籍" : "文章") : source.type === "free" ? "随手记" : undefined;
  const commitSaved = () => {
    const name = naming?.trim();
    setNaming(null);
    if (!name) return;
    persistSaved([...saved, { id: `${Date.now()}`, name, filter: { ...filter }, source }]);
    notify(`已收藏筛选「${name}」`);
  };
  const applySaved = (s: SavedFilter) => {
    setMode("notes");
    setSource(s.source);
    setFilter(s.filter);
    setDrawer(false);
  };

  const selectTag = (tag: string, multi: boolean) => {
    setMode("notes");
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
      notify(`${merging ? "已合并到" : "已改名为"} #${to}，更新了 ${n} 条笔记`);
      setFilter((f) => ({ ...f, tags: f.tags.map((t) => (t === from || t.startsWith(`${from}/`) ? to + t.slice(from.length) : t)) }));
    } catch (e) {
      notify(String(e));
    }
  };
  const remove = async (tag: string) => {
    if (!(await confirmDialog(`从所有笔记中移除标签 #${tag}（包括它的子标签）？\n笔记本身不会被删除。`))) return;
    const n = await notesStore.deleteTag(tag);
    notify(`已从 ${n} 条笔记中移除 #${tag}`);
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
            <button className="tree-label" onClick={(e) => selectTag(n.tag, e.ctrlKey || e.metaKey)} title={`#${n.tag}（Ctrl 点击可多选）`}>
              {n.pinned ? <Pin size={12} className="tree-pin" /> : <Hash size={12} />}
              <span>{n.name}</span>
            </button>
          )}
          <span className="tree-count">{n.count}</span>
          <span className="tree-actions">
            <button title={n.pinned ? "取消置顶" : "置顶"} onClick={() => notesStore.pinTag(n.tag, !n.pinned)}>
              {n.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button title="改名 / 移动 / 合并（输入完整路径）" onClick={() => setRenaming(n.tag)}>
              <Pencil size={12} />
            </button>
            <button title="移除此标签" className="danger" onClick={() => remove(n.tag)}>
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

  const sidebar = (
    <aside className={`hub-side ${drawer ? "open" : ""}`}>
      <Heatmap selected={filter.day} onPick={pickDay} />
      <div className="side-section">
        <button className={`side-item review-entry ${mode === "review" ? "on" : ""}`} onClick={() => (setMode("review"), setDrawer(false))}>
          <Sparkles size={14} />
          <span className="side-label">每日回顾</span>
        </button>
        {src({ type: "all" }, "全部笔记", total, <LibraryIcon size={14} />)}
        {src({ type: "kind", kind: "book" }, "书籍", bookCount("book"), <BookOpen size={14} />)}
        {src({ type: "kind", kind: "article" }, "文章", bookCount("article"), <FileText size={14} />)}
        {src({ type: "free" }, "随手记", counts[FREE_BOOK] ?? 0, <NotebookPen size={14} />)}
      </div>
      {(saved.length > 0 || naming !== null) && (
        <>
          <div className="side-title">收藏的筛选</div>
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
                  <button title="删除收藏" className="danger" onClick={() => persistSaved(saved.filter((x) => x.id !== s.id))}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="side-title">标签</div>
      <div className="side-section tree">{tree.length ? tree.map((n) => renderNode(n, 0)) : <div className="side-empty">在笔记里输入 #标签/子标签 即可创建</div>}</div>
      <div className="side-title">来源</div>
      <div className="side-section">
        {books
          .filter((b) => counts[b.id])
          .sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0))
          .map((b) => src({ type: "book", id: b.id }, b.title, counts[b.id] ?? 0, <DocTypeBadge type={docType(b)} inline size={15} />))}
      </div>
    </aside>
  );

  return (
    <div className="hub">
      {sidebar}
      {drawer && <div className="hub-scrim" onClick={() => setDrawer(false)} />}
      <section className="hub-main">
        {mode === "review" ? (
          <>
            <button className="icon-btn hub-drawer-btn review-drawer" title="标签与来源" onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
            <Review books={bookMap} theme={theme} onOpenNote={onOpenNote} />
          </>
        ) : (
          <>
          <MemoComposer prefillTags={filter.tags} notify={notify} />
          <NotesBrowser
            theme={theme}
            filter={filter}
            onFilter={setFilter}
            books={bookMap}
            batch
            notify={notify}
            exportHeading={`笔记 · ${describeFilter(filter, bookMap, sourceLabel)}`}
            onSaveFilter={() => (setNaming(describeFilter(filter, bookMap, sourceLabel)), setDrawer(true))}
            onOpen={openNote}
            headerExtra={
              <button className="icon-btn hub-drawer-btn" title="标签与来源" onClick={() => setDrawer((d) => !d)}>
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
