import { useEffect, useMemo, useState } from "react";
import { BookOpen, CheckSquare, Compass, FilePlus2, Layers, LayoutGrid, List, Pencil, Search, Settings as SettingsIcon, Square, StickyNote, Tags, Trash2, X } from "lucide-react";
import { STATUS_LABEL, readStatus, type BookRecord, type ReadStatus } from "../core/types";
import type { Theme } from "../settings";
import type { NoteHit } from "../notes/store";
import { NotesHub, kindOf } from "./NotesHub";
import { Inbox } from "./Inbox";
import { feedsApi, interestCounts, useFeedsVersion, type FeedItem } from "../feeds/api";
import { InterestChip } from "./InterestPicker";
import { InterestDialog } from "./InterestDialog";
import { BookInfoDialog } from "./BookInfoDialog";
import { BatchTagDialog } from "./BatchTagDialog";
import { DOC_TYPES, DocTypeBadge, docType } from "./DocTypeBadge";

/** Pseudo-interest used by the 未分类 chip. */
const NONE = "\u0000none";

type ShelfMode = "cover" | "list";
const MODE_KEY = "reader:shelf-mode";
const loadMode = (): ShelfMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "list" ? "list" : "cover";
  } catch {
    return "cover";
  }
};

const FORMAT_LABEL: Record<string, string> = { epub: "EPUB", pdf: "PDF", txt: "TXT", md: "Markdown", html: "网页" };

const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  return new Date(t).toLocaleDateString();
};

/** Five-star mark: filled for the rating, faint for the rest. */
function Stars({ n }: { n: number }) {
  return (
    <span className="mini-stars" title={`${n} 星`}>
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
  view: "shelf" | "feeds" | "notes";
  onView(v: "shelf" | "feeds" | "notes"): void;
  unread: number;
  feedProgress: { done: number; total: number } | null;
  lastFeedRefresh: number | null;
  onRefreshFeeds(): void;
  onSaveFeedItem(item: FeedItem, sourceTitle?: string, interests?: string[]): Promise<string | null>;
  onUpdateBook(id: string, patch: Partial<BookRecord>): void;
  onOpenBookId(id: string): void;
  onOpenNote(hit: NoteHit): void;
  notify(msg: string): void;
  onClip(): void;
  onSettings(): void;
  theme: Theme;
  busy: boolean;
  onImport(): void;
  onOpen(b: BookRecord): void;
  onRemove(b: BookRecord): void;
}

export function Library(props: Props) {
  const { books, counts, docCounts, view, onView, onOpenNote, notify, onClip, theme, busy, onImport, onOpen, onRemove } = props;
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
  const recent = all[0];
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
    notify(`已给 ${chosenBooks.length} 项加上：${tags.join("、")}`);
  };
  const removeTags = (tags: string[]) => {
    for (const b of chosenBooks) {
      const rest = (b.interests ?? []).filter((t) => !tags.includes(t));
      props.onUpdateBook(b.id, { interests: rest.length ? rest : undefined });
    }
    notify(`已从 ${chosenBooks.length} 项去掉：${tags.join("、")}`);
  };
  const setStatusOf = (s: ReadStatus | undefined) => {
    for (const b of chosenBooks) props.onUpdateBook(b.id, { status: s });
    notify(s ? `已把 ${chosenBooks.length} 项设为「${STATUS_LABEL[s]}」` : `已让 ${chosenBooks.length} 项的阅读状态恢复自动`);
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
              <span className="row-note-mark" title={`有 ${docCounts[b.id]} 条整体笔记`}>
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
              {[b.sourceUrl ? b.siteName || label : b.author || label, noteCount(b) ? `${noteCount(b)} 条笔记` : "", ago(b.lastOpenedAt)].filter(Boolean).join(" · ")}
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
            title="改名与附注"
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(b.id);
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            title="阅读兴趣"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(b.id);
            }}
          >
            <Tags size={14} />
          </button>
          <button
            title="从书库移除"
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
        <div className={`cover ${b.sourceUrl ? "web" : ""}`} style={{ background: `linear-gradient(155deg, ${from}, ${to})` }}>
          <span className="cover-format">{b.sourceUrl ? b.siteName || "网页" : (FORMAT_LABEL[b.format] ?? b.format)}</span>
          <DocTypeBadge type={type} />
          {docCounts[b.id] > 0 && (
            <span className="cover-doc" title={`有 ${docCounts[b.id]} 条整体笔记`}>
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
            title="改名与附注"
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(b.id);
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            className="book-tag"
            title="阅读兴趣"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(b.id);
            }}
          >
            <Tags size={14} />
          </button>
          <button
            className="book-remove"
            title="从书库移除"
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
            {noteCount(b) ? `${noteCount(b)} 条笔记 · ` : ""}
            {ago(b.lastOpenedAt)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={`library theme-${theme} view-${view} ${selecting ? "shelf-selecting" : ""}`}>
      <header className="lib-header">
        <div className="brand">
          <span className="brand-mark">墨</span>
          <div>
            <div className="brand-name">墨边</div>
            <div className="brand-sub">墨落两边，读懂字里行间</div>
          </div>
        </div>
        <div className="segmented lib-switch">
          <button className={view === "notes" ? "on" : ""} onClick={() => onView("notes")}>
            <StickyNote size={15} /> 笔记
          </button>
          <button className={view === "shelf" ? "on" : ""} onClick={() => onView("shelf")}>
            <BookOpen size={15} /> 书架
          </button>
          <button className={view === "feeds" ? "on" : ""} onClick={() => onView("feeds")}>
            <Compass size={15} /> 探索{props.unread > 0 && <span className="tab-badge">{props.unread > 99 ? "99+" : props.unread}</span>}
          </button>
        </div>
        <div className="lib-actions">
          <button className="import-btn" onClick={onImport} disabled={busy}>
            <FilePlus2 size={16} /> {busy ? "正在导入…" : "导入文档"}
          </button>
          <button className="icon-btn" onClick={props.onSettings} title="设置">
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>

      {view === "feeds" ? (
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
      ) : view === "notes" ? (
        <NotesHub books={books} counts={counts} theme={theme} onOpenNote={onOpenNote} notify={notify} />
      ) : !books.length ? (
        <div className="lib-empty" onClick={onImport}>
          <BookOpen size={40} strokeWidth={1.2} />
          <h2>把书拖到这里</h2>
          <p>支持 EPUB、PDF、Markdown、TXT、HTML。也可以点击导入，或在系统里双击文件用「墨边」打开。</p>
          <p>
            网络文章：在「探索」页点「添加网文」，或直接在这里 <b>Ctrl + V</b> 粘贴网址。
          </p>
        </div>
      ) : (
        <>
          {recent && recent.progress > 0 && (
            <button className="continue" onClick={() => onOpen(recent)}>
              <span className="continue-label">继续阅读</span>
              <span className="continue-title">{recent.title}</span>
              <span className="continue-bar">
                <i style={{ width: `${Math.round(recent.progress * 100)}%` }} />
              </span>
              <span className="continue-meta">
                {Math.round(recent.progress * 100)}% · {noteCount(recent)} 条笔记 · {ago(recent.lastOpenedAt)}
              </span>
            </button>
          )}
          {(
            <div className="shelf-filter">
              {nArticles > 0 &&
                (
                  [
                    ["all", `全部 ${books.length}`],
                    ["book", `书籍 ${books.length - nArticles}`],
                    ["article", `文章 ${nArticles}`],
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
                <input value={query} placeholder="搜索标题、作者、兴趣…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))} />
                {query && (
                  <button onClick={() => setQuery("")} title="清空">
                    <X size={12} />
                  </button>
                )}
              </label>
              <button className={`filter-chip ${selecting ? "on" : ""}`} onClick={() => (selecting ? exitSelecting() : setSelecting(true))} title="批量选择，一次给多本书打兴趣标签、改阅读状态">
                <CheckSquare size={13} /> 选择
              </button>
              <div className="segmented small view-switch" role="group" aria-label="显示方式">
                <button className={mode === "cover" ? "on" : ""} onClick={() => setMode("cover")} title="封面模式">
                  <LayoutGrid size={13} /> 封面
                </button>
                <button className={mode === "list" ? "on" : ""} onClick={() => setMode("list")} title="列表模式：分栏显示，更适合文章很多的时候">
                  <List size={13} /> 列表
                </button>
              </div>
            </div>
          )}
          {(bookInterests.length > 0 || vocabulary.length > 0) && (
            <div className="shelf-filter shelf-interests">
              <span className="shelf-filter-label">阅读兴趣</span>
              {bookInterests.map((i) => (
                <InterestChip key={i.name} name={i.name} on={picked.includes(i.name)} onClick={() => togglePick(i.name)} />
              ))}
              {bookInterests.length > 0 && uncategorized > 0 && (
                <button className={`filter-chip ${picked.includes(NONE) ? "on" : ""}`} onClick={() => togglePick(NONE)}>
                  未分类 {uncategorized}
                </button>
              )}
              {picked.length > 0 && (
                <button className="link" onClick={() => setPicked([])}>
                  清除
                </button>
              )}
              <span className="nb-spacer" />
              <button className={`filter-chip ${grouped ? "on" : ""}`} onClick={() => setGrouped((g) => !g)} title="把书架按阅读兴趣分成几组">
                <Layers size={13} /> 按兴趣分组
              </button>
            </div>
          )}
          {bookInterests.length === 0 && (
            <div className="shelf-hint">
              <Tags size={13} /> 鼠标移到封面上，点标签图标，给书和文章标注「阅读兴趣」，就能分类和筛选了。从订阅里保存的文章会自动带上订阅源的兴趣。
            </div>
          )}
          {!sorted.length && <div className="nb-empty">没有符合条件的书或文章</div>}
          {groups ? (
            groups.map(([t, list]) => (
              <section key={t} className="shelf-group">
                <h3>
                  {t === NONE ? "未分类" : <InterestChip name={t} />}
                  <em>{list.length}</em>
                </h3>
                <div className={gridClass}>{list.map((b) => renderItem(b, `${t}:`))}</div>
              </section>
            ))
          ) : (
            <div className={gridClass}>{sorted.map((b) => renderItem(b))}</div>
          )}
        </>
      )}
      {view === "shelf" && selecting && (
        <div className="shelf-batch">
          <span className="batch-count">已选 {selected.size} 项</span>
          <button className="batch-btn" onClick={() => setSelected(new Set(sorted.map((b) => b.id)))} disabled={!sorted.length} title="选中当前筛选和搜索出来的全部">
            全选当前结果（{sorted.length}）
          </button>
          <button className="batch-btn" onClick={() => setSelected(new Set())} disabled={!selected.size}>
            清除选择
          </button>
          <span className="batch-sep" />
          <button className="batch-btn" onClick={() => setBatchDlg("add")} disabled={!selected.size}>
            <Tags size={14} /> 加兴趣标签
          </button>
          <button className="batch-btn" onClick={() => setBatchDlg("remove")} disabled={!selected.size || !carriedTags.length}>
            去掉标签
          </button>
          <span className="batch-sep" />
          {(["want", "reading", "done"] as ReadStatus[]).map((s) => (
            <button key={s} className="batch-btn" onClick={() => setStatusOf(s)} disabled={!selected.size}>
              {STATUS_LABEL[s]}
            </button>
          ))}
          <button className="batch-btn" onClick={() => setStatusOf(undefined)} disabled={!selected.size} title="让阅读状态按阅读进度自动判断">
            状态自动
          </button>
          <span className="nb-spacer" />
          <button className="primary-btn small" onClick={exitSelecting}>
            完成
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
