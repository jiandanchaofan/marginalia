import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, Bookmark, CheckCheck, Eye, EyeOff, Globe, Inbox as InboxIcon, Loader2, Plus, RefreshCw, Rss, Search, Tags, Trash2, Undo2, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import { feedsApi, feedsChanged, interestCounts, setSourceInterests, useFeedsVersion, type FeedItem, type ItemView, type Source } from "../feeds/api";
import { refreshSource } from "../feeds/refresh";
import { fetchSummary } from "../feeds/summary";
import { confirmDialog } from "../platform";
import { AddSourceDialog } from "./AddSourceDialog";
import { Preview } from "./Preview";
import { InterestChip } from "./InterestPicker";
import { InterestDialog } from "./InterestDialog";

const PAGE = 60;
const DAY = 86_400_000;

const dayLabel = (t: number) => {
  const d = new Date(t);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return "今天";
  if (t >= start.getTime() - DAY) return "昨天";
  if (t >= start.getTime() - 6 * DAY) return `星期${"日一二三四五六"[d.getDay()]}`;
  return d.getFullYear() === start.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
const timeLabel = (t: number) => {
  const diff = Date.now() - t;
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / 3600_000)} 小时前`;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

interface Props {
  books: BookRecord[];
  refreshing: { done: number; total: number } | null;
  lastRefresh: number | null;
  onRefresh(): void;
  /** Clip into the library; resolves with the book id. */
  onSave(item: FeedItem, sourceTitle?: string, interests?: string[]): Promise<string | null>;
  onOpenBook(id: string): void;
  /** Open the 保存网页 dialog. */
  onClip(): void;
  notify(msg: string): void;
}

export function Inbox({ books, refreshing, lastRefresh, onRefresh, onSave, onOpenBook, onClip, notify }: Props) {
  const version = useFeedsVersion();
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [view, setView] = useState<ItemView>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<{ items: FeedItem[]; total: number }>({ items: [], total: 0 });
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [interests, setInterests] = useState<string[]>([]); // selected interest filters (any-of)
  const [editingInterests, setEditingInterests] = useState<string | null>(null); // source id
  const saved = useMemo(() => new Set(books.map((b) => b.id)), [books]);
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  useEffect(() => {
    // Hand-picked articles first, then subscriptions in the order they were added.
    feedsApi
      .sources()
      .then((list) => setSources([...list].sort((a, b) => Number(b.kind === "manual") - Number(a.kind === "manual"))))
      .catch(() => {});
  }, [version]);
  const interestList = useMemo(() => interestCounts(sources), [sources]);
  // Sources that carry any of the selected interests (null = no interest filter).
  const interestSourceIds = useMemo(
    () => (interests.length ? sources.filter((s) => s.interests?.some((t) => interests.includes(t))).map((s) => s.id) : null),
    [interests, sources],
  );
  const interestKey = interestSourceIds?.join(",") ?? "";
  useEffect(() => setLimit(PAGE), [sourceId, view, q, interestKey]);
  useEffect(() => {
    let alive = true;
    feedsApi
      .query({ sourceId: sourceId ?? undefined, sourceIds: sourceId ? undefined : (interestSourceIds ?? undefined), view, q: q.trim() || undefined, limit })
      .then((r) => alive && setPage(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, interestKey, view, q, limit, version]);
  const toggleInterest = (name: string) => {
    setSourceId(null);
    setInterests((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  };
  // A removed interest can't stay selected.
  useEffect(() => {
    const known = new Set(interestList.map((i) => i.name));
    setInterests((cur) => (cur.every((t) => known.has(t)) ? cur : cur.filter((t) => known.has(t))));
  }, [interestList]);

  const setStatus = async (item: FeedItem, status: FeedItem["status"]) => {
    await feedsApi.setStatus([item.id], status);
    feedsChanged();
  };
  const save = async (item: FeedItem) => {
    setSaving((s) => new Set(s).add(item.id));
    try {
      const id = await onSave(item, byId.get(item.sourceId)?.title, byId.get(item.sourceId)?.interests);
      if (id) await setStatus(item, "saved");
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      });
    }
  };
  /** Read it in the app (reader-mode preview) — never bounce to the system browser. */
  const openPreview = (item: FeedItem) => {
    setPreviewId(item.id);
    if (item.status === "new") setStatus(item, "read");
  };
  const previewIndex = previewId ? page.items.findIndex((i) => i.id === previewId) : -1;
  const previewItem = previewIndex >= 0 ? page.items[previewIndex] : null;
  const step = (d: number) => {
    const next = page.items[previewIndex + d];
    if (next) openPreview(next);
    else if (d > 0 && page.total > page.items.length) setLimit((l) => l + PAGE);
  };

  // Title-only items (e.g. WeChat 合集): fetch the first paragraph when they scroll into view.
  const queue = useRef<string[]>([]);
  const inflight = useRef(new Set<string>());
  const pump = useCallback(() => {
    while (inflight.current.size < 2 && queue.current.length) {
      const id = queue.current.shift()!;
      const item = page.items.find((i) => i.id === id);
      if (!item || inflight.current.has(id)) continue;
      inflight.current.add(id);
      fetchSummary(item.url)
        .then(async (s) => {
          const text = s || "（未能提取首段）";
          setSummaries((m) => ({ ...m, [id]: text }));
          if (s) await feedsApi.setSummary(id, s);
        })
        .catch(() => setSummaries((m) => ({ ...m, [id]: "（未能提取首段）" })))
        .finally(() => {
          inflight.current.delete(id);
          pump();
        });
    }
  }, [page.items]);
  const observer = useMemo(
    () =>
      new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.need;
            if (e.isIntersecting && id && !queue.current.includes(id)) queue.current.push(id);
          }
          pump();
        },
        { rootMargin: "200px" },
      ),
    [pump],
  );
  useEffect(() => () => observer.disconnect(), [observer]);

  const removeSource = async (s: Source) => {
    if (!(await confirmDialog(`取消订阅「${s.title}」？已保存到书架的文章不受影响。`))) return;
    await feedsApi.deleteSource(s.id);
    if (sourceId === s.id) setSourceId(null);
    feedsChanged();
  };

  const totalUnread = sources.reduce((n, s) => n + s.unread, 0);
  const current = sourceId ? byId.get(sourceId) : null;
  const scopeLabel = current ? current.title : interests.length ? interests.join(" / ") : "";
  let lastDay = "";

  const side = (
    <aside className={`hub-side ${drawer ? "open" : ""}`}>
      <div className="side-cta">
        <button className="cta-btn cta-subscribe" onClick={() => setAdding(true)}>
          <Plus size={18} />
          <span>添加订阅</span>
        </button>
        <button
          className="cta-btn cta-clip"
          onClick={() => {
            setDrawer(false);
            onClip();
          }}
          title="保存一篇网页文章（也可以直接 Ctrl+V 粘贴网址）"
        >
          <Globe size={18} />
          <span>添加网文</span>
        </button>
      </div>

      <div className="side-section">
        <button
          className={`side-item ${!sourceId && !interests.length ? "on" : ""}`}
          onClick={() => {
            setSourceId(null);
            setInterests([]);
            setDrawer(false);
          }}
        >
          <InboxIcon size={14} />
          <span className="side-label">全部文章</span>
          {totalUnread > 0 && <span className="tree-count unread">{totalUnread}</span>}
        </button>
      </div>

      {interestList.length > 0 && (
        <>
          <div className="side-title">阅读兴趣</div>
          <div className="side-interests">
            {interestList.map((i) => (
              <InterestChip key={i.name} name={i.name} on={interests.includes(i.name)} onClick={() => toggleInterest(i.name)} />
            ))}
          </div>
        </>
      )}

      <div className="side-title">来源</div>
      <div className="side-section">
        {sources.map((s) => (
          <div key={s.id} className={`tree-row source-row-side ${sourceId === s.id ? "on" : ""}`}>
            <button
              className="tree-label"
              onClick={() => (setSourceId(s.id), setDrawer(false))}
              title={s.kind === "manual" ? "通过「添加网文」、粘贴网址或浏览器书签保存的文章" : s.lastError ? `上次更新失败：${s.lastError}` : s.feedUrl}
            >
              {s.kind === "manual" ? <Bookmark size={12} /> : s.lastError ? <AlertCircle size={13} className="src-error" /> : <Rss size={12} />}
              <span className="src-name">
                <b>{s.title}</b>
                {s.interests?.length > 0 && <small>{s.interests.join(" · ")}</small>}
              </span>
            </button>
            {s.kind === "manual" ? <span className="tree-count">{s.total}</span> : s.unread > 0 && <span className="tree-count unread">{s.unread}</span>}
            <span className="tree-actions" hidden={s.kind === "manual"}>
              <button title="阅读兴趣" onClick={() => setEditingInterests(s.id)}>
                <Tags size={12} />
              </button>
              <button
                title="立即更新"
                onClick={async () => {
                  const r = await refreshSource(s, true);
                  feedsChanged();
                  notify(r.error ? `「${s.title}」更新失败：${r.error}` : `「${s.title}」新增 ${r.added} 篇`);
                }}
              >
                <RefreshCw size={12} />
              </button>
              <button title="取消订阅" className="danger" onClick={() => removeSource(s)}>
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
        {!sources.length && <div className="side-empty">还没有来源</div>}
      </div>
    </aside>
  );

  return (
    <div className="hub inbox">
      {side}
      {drawer && <div className="hub-scrim" onClick={() => setDrawer(false)} />}
      <section className="hub-main">
        <div className="nb-toolbar">
          <label className="nb-search">
            <Search size={15} />
            <input value={q} placeholder="搜索标题与首段" onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button onClick={() => setQ("")}>
                <X size={14} />
              </button>
            )}
          </label>
          <button className="icon-btn" title={refreshing ? "正在更新" : "更新全部订阅"} onClick={onRefresh} disabled={!!refreshing}>
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
          </button>
          <button className="icon-btn hub-drawer-btn" title="订阅源" onClick={() => setDrawer((d) => !d)}>
            <Rss size={17} />
          </button>
        </div>
        <div className="nb-filters">
          <div className="segmented small">
            {(
              [
                ["all", "全部"],
                ["unread", "未读"],
                ["saved", "已保存"],
                ["dismissed", "已忽略"],
              ] as [ItemView, string][]
            ).map(([v, label]) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </div>
          <span className="nb-spacer" />
          <span className="inbox-status">
            {refreshing
              ? `正在更新 ${refreshing.done}/${refreshing.total}`
              : current?.lastError
                ? `更新失败：${current.lastError}`
                : lastRefresh
                  ? `${timeLabel(lastRefresh)}更新`
                  : ""}
          </span>
          {(current ? current.unread : totalUnread) > 0 && (
            <button
              className="filter-chip"
              onClick={async () => {
                await feedsApi.markAllRead(sourceId ?? undefined);
                feedsChanged();
              }}
            >
              <CheckCheck size={13} /> 全部标为已读
            </button>
          )}
        </div>
        <div className="nb-count">
          {scopeLabel ? `${scopeLabel} · ` : ""}共 {page.total} 篇
        </div>

        <div className="nb-list feed-list">
          {!sources.length && (
            <div className="nb-empty inbox-empty">
              <Rss size={34} strokeWidth={1.3} />
              <p>
                这里是寻找好文章的地方：订阅常看的博客、网站或公众号合集，新文章会按时间汇集在这里；偶然读到的好文章，点「添加网文」或直接 Ctrl+V 粘贴网址。
              </p>
              <div className="inbox-empty-actions">
                <button className="primary-btn" onClick={() => setAdding(true)}>
                  <Plus size={16} /> 添加订阅
                </button>
                <button className="secondary-btn" onClick={onClip}>
                  <Globe size={16} /> 添加网文
                </button>
              </div>
            </div>
          )}
          {sources.length > 0 && !page.items.length && <div className="nb-empty">{view === "unread" ? "没有未读文章了 ✓" : "没有文章"}</div>}
          {page.items.map((item) => {
            const day = dayLabel(item.publishedAt);
            const header = day !== lastDay ? ((lastDay = day), <div className="nb-group">{day}</div>) : null;
            const isSaved = item.status === "saved" || saved.has(item.id);
            const summary = item.summary || summaries[item.id];
            return (
              <div key={item.id}>
                {header}
                <article
                  className={`feed-item ${item.status}`}
                  data-need={summary ? undefined : item.id}
                  ref={(el) => {
                    if (el && !summary) observer.observe(el);
                  }}
                >
                  <div className="fi-meta">
                    {item.status === "new" && <span className="fi-dot" />}
                    <span className="fi-source">{byId.get(item.sourceId)?.title ?? ""}</span>
                    {(byId.get(item.sourceId)?.interests ?? []).slice(0, 3).map((t) => (
                      <InterestChip key={t} name={t} small />
                    ))}
                    {item.author && <span>{item.author}</span>}
                    <span>{timeLabel(item.publishedAt)}</span>
                  </div>
                  <h3 className="fi-title" onClick={() => openPreview(item)} title="在应用内预览">
                    {item.title || item.url}
                  </h3>
                  <p className={`fi-summary ${summary ? "" : "pending"}`}>{summary || "正在获取首段…"}</p>
                  <div className="fi-actions">
                    {isSaved ? (
                      <button className="fi-btn primary ghost" onClick={() => onOpenBook(item.id)}>
                        <BookOpen size={14} /> 已保存 · 打开精读
                      </button>
                    ) : (
                      <button className="fi-btn primary" disabled={saving.has(item.id)} onClick={() => save(item)}>
                        {saving.has(item.id) ? <Loader2 size={14} className="spin" /> : <BookOpen size={14} />}
                        {saving.has(item.id) ? "保存中…" : "保存精读"}
                      </button>
                    )}
                    {item.status === "dismissed" ? (
                      <button className="fi-btn" onClick={() => setStatus(item, "read")}>
                        <Undo2 size={14} /> 恢复
                      </button>
                    ) : (
                      !isSaved && (
                        <button className="fi-btn" onClick={() => setStatus(item, "dismissed")}>
                          <EyeOff size={14} /> 忽略
                        </button>
                      )
                    )}
                    <button className="fi-btn" onClick={() => openPreview(item)}>
                      <Eye size={14} /> 预览
                    </button>
                  </div>
                </article>
              </div>
            );
          })}
          {page.total > page.items.length && (
            <button className="nb-more" onClick={() => setLimit((l) => l + PAGE)}>
              加载更多（还有 {page.total - page.items.length} 篇）
            </button>
          )}
        </div>
      </section>
      {adding && <AddSourceDialog existing={sources} onClose={() => setAdding(false)} notify={notify} />}
      {editingInterests && byId.get(editingInterests) && (
        <InterestDialog
          title={byId.get(editingInterests)!.title}
          value={byId.get(editingInterests)!.interests ?? []}
          all={interestList.map((i) => i.name)}
          onChange={(v) => setSourceInterests(byId.get(editingInterests)!, v)}
          onClose={() => setEditingInterests(null)}
        />
      )}
      {previewItem && (
        <Preview
          item={previewItem}
          sourceTitle={byId.get(previewItem.sourceId)?.title}
          saved={previewItem.status === "saved" || saved.has(previewItem.id)}
          saving={saving.has(previewItem.id)}
          hasPrev={previewIndex > 0}
          hasNext={previewIndex < page.items.length - 1 || page.total > page.items.length}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onSave={() => save(previewItem)}
          onOpenSaved={() => onOpenBook(previewItem.id)}
          onDismiss={async () => {
            const next = page.items[previewIndex + 1];
            await setStatus(previewItem, "dismissed");
            if (next) openPreview(next);
            else setPreviewId(null);
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}
