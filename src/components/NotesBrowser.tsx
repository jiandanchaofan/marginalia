import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, CheckSquare, Copy, Download, Hash, ImagePlus, Palette, Pencil, Search, Square, Star, StickyNote, Tag, Trash2, X } from "lucide-react";
import { isDocNote, isFreeNote, type Annotation, type BookRecord } from "../core/types";
import { PALETTE, styleName, swatch } from "../core/palette";
import { filterHits, notesStore, tagStats, useGlobalTags, useNotesVersion, type NoteHit } from "../notes/store";
import { addTag, buildTree, hasThought, parseTags, removeTag } from "../notes/tags";
import { EMPTY_FILTER, dayLabel, isFiltered, imageIdsOf, notesToMarkdown, safeFileName, toQuery, type NotesFilter } from "../notes/query";
import type { Theme } from "../settings";
import { confirmDialog, exportTextFile } from "../platform";
import { Marked, NoteText } from "./NoteText";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { FormatBar } from "./FormatBar";
import { NoteImages } from "./NoteImages";

export { EMPTY_FILTER, type NotesFilter };

const PAGE = 60;
const fmtDate = (t: number) => {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

interface Props {
  theme: Theme;
  filter: NotesFilter;
  onFilter(f: NotesFilter): void;
  books: Map<string, BookRecord>;
  /** Live notes of one book (in-book panel). Omitted → query the global store. */
  source?: NoteHit[];
  chapterOf?(section: number): string;
  /** In-book panel: show a compact tag picker above the list. */
  tagPicker?: boolean;
  compact?: boolean;
  /** Enable multi-select + batch actions (global store only). */
  batch?: boolean;
  /** Title used for "export current results"; omit to hide the button. */
  exportHeading?: string;
  /** Show a ☆ to save the current filter. */
  onSaveFilter?(): void;
  onOpen(hit: NoteHit): void;
  /** Override persistence (in-book list edits go through the reader's own state). */
  onEdit?(hit: NoteHit, patch: Partial<Annotation>): void;
  onDelete?(hit: NoteHit): void;
  headerExtra?: React.ReactNode;
  notify?(msg: string): void;
}

export function NotesBrowser(props: Props) {
  const { theme, filter, onFilter, books, source, chapterOf, tagPicker, compact, batch, exportHeading, onSaveFilter, onOpen, onEdit, onDelete, headerExtra, notify } = props;
  const version = useNotesVersion();
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ items: NoteHit[]; total: number }>({ items: [], total: 0 });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, NoteHit>>(new Map());
  const query = useMemo(() => toQuery(filter, books), [filter, books]);
  const set = (p: Partial<NotesFilter>) => onFilter({ ...filter, ...p });

  useEffect(() => setLimit(PAGE), [filter]);
  useEffect(() => {
    if (source) {
      const all = filterHits(source, query);
      setResult({ items: all.slice(0, limit), total: all.length });
      return;
    }
    let alive = true;
    notesStore.query({ ...query, limit, offset: 0 }).then((r) => alive && setResult(r));
    return () => {
      alive = false;
    };
  }, [query, limit, version, source]);

  // Selection survives search/filter changes: refresh entries that are visible, keep the rest as they are.
  useEffect(() => {
    setSelected((old) => {
      if (!old.size) return old;
      const fresh = new Map(result.items.map((h) => [h.note.id, h]));
      return new Map([...old].map(([id, h]) => [id, fresh.get(id) ?? h]));
    });
  }, [result]);
  const replaceSelected = (hits: NoteHit[]) =>
    setSelected((old) => {
      const next = new Map(old);
      hits.forEach((h) => next.has(h.note.id) && next.set(h.note.id, h));
      return next;
    });

  const toggleTag = (tag: string) => set({ tags: filter.tags.includes(tag) ? filter.tags.filter((t) => t !== tag) : [...filter.tags, tag] });

  const save = async (hit: NoteHit, patch: Partial<Annotation>) => {
    if (onEdit) return onEdit(hit, patch);
    await notesStore.update(hit.bookId, { ...hit.note, ...patch, updatedAt: Date.now() });
  };
  const remove = async (hit: NoteHit) => {
    if (onDelete) return onDelete(hit);
    if (!(await confirmDialog(isFreeNote(hit.note) ? "删除这条随手记？" : "删除这条笔记？原文中的标注也会一并移除。"))) return;
    await notesStore.remove(hit.bookId, hit.note.id);
  };

  const exportResults = async () => {
    const hits = selecting && selected.size ? [...selected.values()] : source ? filterHits(source, query) : (await notesStore.query({ ...query, limit: -1 })).items;
    if (!hits.length) return;
    const heading = exportHeading ?? "笔记";
    try {
      const ok = await exportTextFile(`${safeFileName(heading)}.md`, notesToMarkdown(hits, books, heading), imageIdsOf(hits));
      if (ok) notify?.(`已导出 ${hits.length} 条笔记`);
    } catch (e) {
      notify?.(`导出失败：${e}`);
    }
  };

  const toggleSelect = (hit: NoteHit) =>
    setSelected((old) => {
      const next = new Map(old);
      if (next.has(hit.note.id)) next.delete(hit.note.id);
      else next.set(hit.note.id, hit);
      return next;
    });
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Map());
  };

  const groupByType = filter.sort === "type" && !source;
  const typeOf = (a: Annotation) => (a.kind === "free" ? "随手记" : a.kind === "doc" ? "阅读全局笔记" : hasThought(a.note) ? "批注笔记" : "原文摘录");
  let lastKind = "";
  let lastChapter = "";

  return (
    <div className={`notes-browser ${compact ? "compact" : ""} ${selecting ? "selecting" : ""}`}>
      <div className="nb-toolbar">
        <label className="nb-search" title="搜索语法： #标签 · 书:标题 · 色:琥珀 · 样式:波浪线 · 批注笔记 · 阅读全局笔记 · 原文摘录 · 随手记">
          <Search size={15} />
          <input
            value={filter.q}
            placeholder={compact ? "搜索，或输入 #标签" : "搜索笔记、#标签、书:标题…"}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && filter.q && (e.stopPropagation(), set({ q: "" }))}
          />
          {filter.q && (
            <button onClick={() => set({ q: "" })} title="清空">
              <X size={14} />
            </button>
          )}
        </label>
        {onSaveFilter && isFiltered(filter) && (
          <button className="icon-btn" title="收藏当前筛选" onClick={onSaveFilter}>
            <Star size={17} />
          </button>
        )}
        {exportHeading && (
          <button className="icon-btn" title={selecting && selected.size ? "导出所选笔记" : "导出当前结果为 Markdown"} onClick={exportResults} disabled={!result.total}>
            <Download size={17} />
          </button>
        )}
        {batch && !source && (
          <button className={`icon-btn ${selecting ? "on" : ""}`} title="批量选择" onClick={() => (selecting ? exitSelect() : setSelecting(true))}>
            <CheckSquare size={17} />
          </button>
        )}
        {headerExtra}
      </div>

      {tagPicker && source && <InlineTagPicker hits={source} selected={filter.tags} onToggle={toggleTag} />}

      <div className="nb-filters">
        {filter.tags.map((t) => (
          <button key={t} className="filter-chip tag" onClick={() => toggleTag(t)}>
            #{t} <X size={12} />
          </button>
        ))}
        {filter.tags.length > 1 && (
          <button className="filter-chip ghost" onClick={() => set({ tagMode: filter.tagMode === "and" ? "or" : "and" })} title="切换标签组合方式">
            {filter.tagMode === "and" ? "同时包含" : "任一包含"}
          </button>
        )}
        {filter.day && (
          <button className="filter-chip tag" onClick={() => set({ day: undefined })} title="取消日期筛选">
            {dayLabel(filter.day)} <X size={12} />
          </button>
        )}
        {!source && (
          <button className={`filter-chip ${filter.kind === "free" ? "on" : ""}`} onClick={() => set({ kind: filter.kind === "free" ? undefined : "free", hasText: undefined })} title="与书籍、文章无关的随手记">
            随手记
          </button>
        )}
        <button
          className={`filter-chip ${filter.kind === "passage" && filter.hasText === true ? "on" : ""}`}
          onClick={() => (filter.kind === "passage" && filter.hasText === true ? set({ kind: undefined, hasText: undefined }) : set({ kind: "passage", hasText: true }))}
          title="阅读时选中文字、并写了文字的笔记"
        >
          批注笔记
        </button>
        <button className={`filter-chip ${filter.kind === "doc" ? "on" : ""}`} onClick={() => set({ kind: filter.kind === "doc" ? undefined : "doc", hasText: undefined })} title="针对整本书 / 整篇文章的笔记">
          阅读全局笔记
        </button>
        <button
          className={`filter-chip ${filter.kind === "passage" && filter.hasText === false ? "on" : ""}`}
          onClick={() => (filter.kind === "passage" && filter.hasText === false ? set({ kind: undefined, hasText: undefined }) : set({ kind: "passage", hasText: false }))}
          title="只有高亮 / 下划线、没有写文字的原文标注"
        >
          原文摘录
        </button>
        <span className="nb-colors">
          {PALETTE.map((p) => (
            <button
              key={p.key}
              title={p.name}
              className={`swatch-dot ${filter.colors.includes(p.key) ? "on" : ""}`}
              style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
              onClick={() => set({ colors: filter.colors.includes(p.key) ? filter.colors.filter((c) => c !== p.key) : [...filter.colors, p.key] })}
            />
          ))}
        </span>
        <span className="nb-spacer" />
        <div className="segmented small">
          <button className={filter.sort === "time" ? "on" : ""} onClick={() => set({ sort: "time" })}>
            时间
          </button>
          <button className={filter.sort === (source ? "position" : "type") ? "on" : ""} onClick={() => set({ sort: source ? "position" : "type" })}>
            {source ? "原文顺序" : "类型"}
          </button>
        </div>
      </div>

      <div className="nb-count">
        共 {result.total} 条笔记
        {(filter.q || filter.tags.length || filter.colors.length || filter.hasText !== undefined || filter.kind || filter.day) && (
          <button className="link" onClick={() => onFilter({ ...EMPTY_FILTER, bookIds: filter.bookIds, sort: filter.sort })}>
            清除筛选
          </button>
        )}
      </div>

      {selecting && (
        <BatchBar
          theme={theme}
          selected={[...selected.values()]}
          pageCount={result.items.length}
          onSelectPage={() => setSelected(new Map(result.items.map((h) => [h.note.id, h])))}
          onClear={() => setSelected(new Map())}
          onExport={exportResults}
          onExit={exitSelect}
          onReplace={replaceSelected}
          notify={notify}
        />
      )}

      <div className="nb-list">
        {!result.items.length && <div className="nb-empty">{result.total === 0 && !filter.q && !filter.tags.length && !filter.day ? (source ? "还没有笔记。选中文字即可开始。" : "还没有笔记。在上方写下第一条随手记，或在阅读时选中文字。") : "没有符合条件的笔记"}</div>}
        {result.items.map((hit) => {
          const book = books.get(hit.bookId);
          let header: React.ReactNode = null;
          if (groupByType && typeOf(hit.note) !== lastKind) {
            lastKind = typeOf(hit.note);
            header = <div className="nb-group">{lastKind}</div>;
          } else if (source && filter.sort === "position" && chapterOf) {
            const ch = isDocNote(hit.note) ? "阅读全局笔记" : chapterOf(hit.note.anchor.section);
            if (ch !== lastChapter) {
              lastChapter = ch;
              header = <div className="nb-group">{ch}</div>;
            }
          }
          return (
            <div key={hit.note.id}>
              {header}
              <NoteItem
                hit={hit}
                theme={theme}
                bookTitle={source || isFreeNote(hit.note) ? undefined : book?.title}
                noun={book && (book.format === "md" || book.format === "html") ? "整篇文章" : "整本书"}
                terms={query.terms}
                activeTags={filter.tags}
                selectable={selecting}
                selected={selected.has(hit.note.id)}
                onSelect={() => toggleSelect(hit)}
                onTag={toggleTag}
                onOpen={() => onOpen(hit)}
                onSave={(p) => save(hit, p)}
                onDelete={() => remove(hit)}
              />
            </div>
          );
        })}
        {result.total > result.items.length && (
          <button className="nb-more" onClick={() => setLimit((l) => l + PAGE)}>
            加载更多（还有 {result.total - result.items.length} 条）
          </button>
        )}
      </div>
    </div>
  );
}

/** Batch actions on the selected notes (global store). */
function BatchBar({
  theme,
  selected,
  pageCount,
  onSelectPage,
  onClear,
  onExport,
  onExit,
  onReplace,
  notify,
}: {
  theme: Theme;
  onReplace(hits: NoteHit[]): void;
  selected: NoteHit[];
  pageCount: number;
  onSelectPage(): void;
  onClear(): void;
  onExport(): void;
  onExit(): void;
  notify?(msg: string): void;
}) {
  const [mode, setMode] = useState<"add" | "remove" | "color" | null>(null);
  const [tagInput, setTagInput] = useState("");
  const globalTags = useGlobalTags();
  const present = useMemo(() => [...new Set(selected.flatMap((h) => parseTags(h.note.note)))].sort((a, b) => a.localeCompare(b, "zh-CN")), [selected]);
  const n = selected.length;
  const now = Date.now();

  const apply = async (fn: (a: Annotation) => Annotation, msg: string) => {
    const changed = selected.map((h) => ({ ...h, note: fn(h.note) })).filter((h, i) => h.note !== selected[i].note);
    if (!changed.length) return setMode(null);
    const stamped = changed.map((h) => ({ ...h, note: { ...h.note, updatedAt: now } }));
    await notesStore.updateMany(stamped);
    onReplace(stamped);
    notify?.(msg.replace("{n}", String(changed.length)));
    setMode(null);
  };
  const addToAll = () => {
    const tag = tagInput.trim().replace(/^#/, "");
    if (!tag) return;
    setTagInput("");
    apply((a) => {
      const note = addTag(a.note, tag);
      return note === a.note ? a : { ...a, note };
    }, `已为 {n} 条笔记添加 #${tag}`);
  };
  const removeFromAll = (tag: string) =>
    apply((a) => {
      const note = removeTag(a.note, tag);
      return note === a.note ? a : { ...a, note };
    }, `已从 {n} 条笔记移除 #${tag}`);
  const recolor = (color: string) => apply((a) => (a.color === color ? a : { ...a, color }), `已为 {n} 条笔记改色`);
  const removeAll = async () => {
    if (!(await confirmDialog(`删除选中的 ${n} 条笔记？原文中的标注也会一并移除。`))) return;
    await notesStore.removeMany(selected);
    notify?.(`已删除 ${n} 条笔记`);
    onClear();
  };

  return (
    <div className="batch-bar">
      <div className="batch-row">
        <span className="batch-count">已选 {n} 条</span>
        <button className="link" onClick={n >= pageCount ? onClear : onSelectPage}>
          {n >= pageCount && n > 0 ? "取消全选" : "全选本页"}
        </button>
        <span className="nb-spacer" />
        <button className={`batch-btn ${mode === "add" ? "on" : ""}`} disabled={!n} onClick={() => setMode(mode === "add" ? null : "add")}>
          <Tag size={14} /> 加标签
        </button>
        <button className={`batch-btn ${mode === "remove" ? "on" : ""}`} disabled={!present.length} onClick={() => setMode(mode === "remove" ? null : "remove")}>
          <Hash size={14} /> 移除标签
        </button>
        <button className={`batch-btn ${mode === "color" ? "on" : ""}`} disabled={!n} onClick={() => setMode(mode === "color" ? null : "color")}>
          <Palette size={14} /> 改颜色
        </button>
        <button className="batch-btn" disabled={!n} onClick={onExport}>
          <Download size={14} /> 导出
        </button>
        <button className="batch-btn danger" disabled={!n} onClick={removeAll}>
          <Trash2 size={14} /> 删除
        </button>
        <button className="batch-btn" onClick={onExit} title="退出选择">
          <X size={14} />
        </button>
      </div>
      {mode === "add" && (
        <div className="batch-row sub">
          <Hash size={14} />
          <input
            className="batch-input"
            autoFocus
            list="batch-tags"
            placeholder="输入标签，如 AI/AI技术（可选已有标签）"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addToAll()}
          />
          <datalist id="batch-tags">
            {globalTags.map((t) => (
              <option key={t.tag} value={t.tag} />
            ))}
          </datalist>
          <button className="batch-btn primary" onClick={addToAll} disabled={!tagInput.trim()}>
            <Check size={14} /> 添加到 {n} 条
          </button>
        </div>
      )}
      {mode === "remove" && (
        <div className="batch-row sub wrap">
          <span className="batch-hint">点击要移除的标签：</span>
          {present.map((t) => (
            <button key={t} className="tag-chip" onClick={() => removeFromAll(t)}>
              #{t} <X size={11} />
            </button>
          ))}
        </div>
      )}
      {mode === "color" && (
        <div className="batch-row sub">
          <span className="batch-hint">改为：</span>
          {PALETTE.map((p) => (
            <button
              key={p.key}
              title={p.name}
              className="swatch-dot big"
              style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
              onClick={() => recolor(p.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteItem({
  hit,
  theme,
  bookTitle,
  noun,
  terms,
  activeTags,
  selectable,
  selected,
  onSelect,
  onTag,
  onOpen,
  onSave,
  onDelete,
}: {
  hit: NoteHit;
  theme: Theme;
  bookTitle?: string;
  noun: string;
  terms?: string[];
  activeTags: string[];
  selectable?: boolean;
  selected?: boolean;
  onSelect?(): void;
  onTag(tag: string): void;
  onOpen(): void;
  onSave(p: Partial<Annotation>): void;
  onDelete(): void;
}) {
  const a = hit.note;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.note);
  const [draftImages, setDraftImages] = useState<string[]>(a.images ?? []);
  const editor = useRef<TagTextareaHandle>(null);
  const sw = swatch(a.color);
  const free = isFreeNote(a);
  const fresh = free && Date.now() - a.createdAt < 4000;
  const [copied, setCopied] = useState(false);
  const copyQuote = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(a.anchor.exact).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const startEdit = () => {
    setDraft(a.note);
    setDraftImages(a.images ?? []);
    setEditing(true);
  };
  const commit = () => {
    if (draft !== a.note || draftImages.join() !== (a.images ?? []).join()) onSave({ note: draft, tags: parseTags(draft), images: draftImages });
    setEditing(false);
  };
  const quote = free ? null : isDocNote(a) ? (
        <button className="nb-doc-badge" onClick={selectable ? undefined : onOpen} title={selectable ? undefined : "打开整体笔记"}>
          <StickyNote size={14} /> {noun}笔记
        </button>
      ) : (
        <div className="nb-quote-wrap">
          {/* Plain text: drag / double-click / triple-click to select part of it. Ctrl + click jumps to the source. */}
          <div
            className="nb-quote"
            title={selectable ? undefined : "可选择部分文字；按住 Ctrl 点击回到原文"}
            onClick={(e) => {
              if (!selectable && (e.ctrlKey || e.metaKey)) {
                e.stopPropagation();
                onOpen();
              }
            }}
          >
            <Marked text={a.anchor.exact} terms={terms} />
          </div>
        </div>
      );
  return (
    <div
      className={`nb-item ${free ? "free" : ""} ${fresh ? "fresh" : ""} ${editing ? "editing" : ""} ${selectable ? "selectable" : ""} ${selected ? "selected" : ""}`}
      style={{ ["--accent" as string]: theme === "dark" ? sw.dark : sw.ink }}
      onClick={selectable ? onSelect : undefined}
      // Double-click anywhere on the card (not on its buttons, tags or pictures) starts editing.
      onDoubleClick={(e) => {
        if (selectable || editing || (e.target as Element).closest("button, a, img, textarea, input, .ni-strip, .nb-quote")) return;
        window.getSelection()?.removeAllRanges();
        startEdit();
      }}
    >
      {selectable && <span className="nb-check">{selected ? <CheckSquare size={17} /> : <Square size={17} />}</span>}
      {quote}
      {editing ? (
        <div className="nb-edit" onClick={(e) => e.stopPropagation()}>
          <TagTextarea ref={editor} className="note-editor" value={draft} onChange={setDraft} images={draftImages} onImages={setDraftImages} autoFocus placeholder="写下你的想法，输入 # 添加标签…" onSubmit={commit} onEscape={() => setEditing(false)} />
          <div className="nb-edit-actions">
            <button className="ni-add" title="添加图片" onClick={() => editor.current?.pickImage()}>
              <ImagePlus size={14} />
            </button>
            <FormatBar onFormat={(k) => editor.current?.format(k)} />
            <span>Ctrl + Enter 保存</span>
            <button onClick={() => setEditing(false)}>取消</button>
            <button className="primary" onClick={commit}>
              <Check size={14} /> 保存
            </button>
          </div>
        </div>
      ) : (
        a.note.trim() && <NoteText className="nb-note" text={a.note} terms={terms} activeTags={activeTags} onTag={selectable ? undefined : onTag} />
      )}
      {!editing && <NoteImages ids={a.images} />}
      <div className="nb-meta">
        {bookTitle && <span className="nb-book">{bookTitle}</span>}
        <span>{fmtDate(a.createdAt)}</span>
        <span>{free ? "随手记" : isDocNote(a) ? "阅读全局笔记" : styleName(a.style)}</span>
        {!selectable && (
          <span className="nb-actions">
            {!free && !isDocNote(a) && (
              <button title="复制整段原文（只想复制一部分：直接选中后 Ctrl + C）" onClick={copyQuote}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
            {!free && (
              <button title="回到原文" onClick={onOpen}>
                <ArrowUpRight size={14} />
              </button>
            )}
            {!editing && (
              <button
                title="编辑"
                onClick={startEdit}
              >
                <Pencil size={13} />
              </button>
            )}
            <button title="删除" className="danger" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** In-book tag picker: tags present in this book, as an indented chip list. */
function InlineTagPicker({ hits, selected, onToggle }: { hits: NoteHit[]; selected: string[]; onToggle(t: string): void }) {
  const tree = useMemo(() => buildTree(tagStats(hits)), [hits]);
  if (!tree.length) return null;
  const flat: { tag: string; name: string; count: number; depth: number }[] = [];
  const walk = (nodes: typeof tree, depth: number) =>
    nodes.forEach((n) => {
      flat.push({ tag: n.tag, name: n.name, count: n.count, depth });
      walk(n.children, depth + 1);
    });
  walk(tree, 0);
  return (
    <div className="nb-tagpicker">
      {flat.map((t) => (
        <button key={t.tag} className={`tag-chip ${selected.includes(t.tag) ? "on" : ""}`} onClick={() => onToggle(t.tag)} title={`#${t.tag}`}>
          {t.depth > 0 && <span className="tag-depth">{"›".repeat(t.depth)}</span>}
          <Hash size={11} />
          {t.name}
          <em>{t.count}</em>
        </button>
      ))}
    </div>
  );
}
