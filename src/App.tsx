import { useCallback, useEffect, useRef, useState } from "react";
import type { BookRecord } from "./core/types";
import { formatOf, loadDocument } from "./core/formats";
import {
  confirmDialog,
  deleteBook,
  importBrowserFile,
  importPath,
  isTauri,
  listenForClips,
  listenForFiles,
  loadLibrary,
  pickFiles,
  readBook,
  saveLibrary,
  setViewZoom,
  settingsStore,
  type ImportedBook,
} from "./platform";
import { DEFAULT_SETTINGS, bodyFont, normalizeSettings, type Settings } from "./settings";
import { Library } from "./components/Library";
import { Reader } from "./components/Reader";
import { notesStore, useNotesVersion, type NoteHit } from "./notes/store";
import { ClipDialog } from "./components/ClipDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { scheduleMdBackup } from "./notes/backup";
import { useZoomControls } from "./useZoom";
import { clipArticle, looksLikeUrl, type ClipResult } from "./web/clip";
import { feedsApi, feedsChanged, recordManualArticle, useFeedsVersion, type FeedItem } from "./feeds/api";
import { refreshAll } from "./feeds/refresh";
import "./styles.css";

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [view, setView] = useState<"shelf" | "feeds" | "notes">("notes");
  const [feedProgress, setFeedProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastFeedRefresh, setLastFeedRefresh] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);
  const feedsVersion = useFeedsVersion();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});
  const [clip, setClip] = useState<{ url?: string; auto?: boolean } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const notesVersion = useNotesVersion();
  const [settings, setSettings] = useState<Settings>(() => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)));
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const booksRef = useRef(books);
  booksRef.current = books;
  const loaded = useRef(false);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4200);
  }, []);

  useEffect(() => {
    loadLibrary().then((b) => {
      setBooks(b);
      loaded.current = true;
    });
  }, []);

  // Persist the library index (debounced; progress updates arrive often).
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => saveLibrary(books).catch((e) => notify(`书库保存失败：${e}`)), 500);
    return () => clearTimeout(t);
  }, [books, notify]);

  const updateSettings = useCallback((p: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...p };
      settingsStore.save(next);
      return next;
    });
  }, []);

  const updateBook = useCallback((id: string, p: Partial<BookRecord>) => {
    setBooks((list) => list.map((b) => (b.id === id ? { ...b, ...p } : b)));
  }, []);

  /** Import files/paths, read their metadata, and open the book when exactly one was imported. */
  const importItems = useCallback(
    async (items: (string | File)[]) => {
      if (!items.length) return;
      setBusy(true);
      const opened: string[] = [];
      for (const item of items) {
        const name = typeof item === "string" ? item.split(/[\\/]/).pop()! : item.name;
        try {
          const imp: ImportedBook = typeof item === "string" ? await importPath(item) : await importBrowserFile(item);
          const format = formatOf(imp.ext);
          if (!format) throw new Error(`不支持的格式 .${imp.ext}`);
          const existing = booksRef.current.find((b) => b.id === imp.id);
          if (!existing) {
            let title = imp.fileName.replace(/\.[^.]+$/, "");
            let author = "";
            try {
              const doc = await loadDocument(await readBook(imp.id, imp.ext), imp.ext, imp.fileName);
              title = doc.title || title;
              author = doc.author;
              doc.destroy();
            } catch (e) {
              throw new Error(`文件已损坏或无法解析（${e instanceof Error ? e.message : e}）`);
            }
            const rec: BookRecord = {
              id: imp.id,
              ext: imp.ext,
              format,
              title,
              author,
              fileName: imp.fileName,
              size: imp.size,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
              progress: 0,
              annotationCount: 0,
            };
            booksRef.current = [...booksRef.current, rec];
            setBooks(booksRef.current);
          }
          opened.push(imp.id);
        } catch (e) {
          notify(`《${name}》导入失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setBusy(false);
      if (opened.length === 1) setOpenId(opened[0]);
      else if (opened.length > 1) notify(`已导入 ${opened.length} 个文档`);
    },
    [notify],
  );

  // Startup argument, file association / second instance, and native drag-and-drop.
  useEffect(() => {
    let off = () => {};
    listenForFiles((paths) => importItems(paths), setDragOver).then((f) => (off = f));
    return () => off();
  }, [importItems]);

  // Browser fallback for drag-and-drop during `npm run dev`.
  useEffect(() => {
    if (isTauri) return;
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      importItems(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [importItems]);

  useEffect(() => {
    notesStore.counts().then(setCounts).catch(() => {});
    notesStore.docCounts().then(setDocCounts).catch(() => {});
  }, [notesVersion, openId]);

  // Subscriptions: refresh shortly after launch, then every 30 minutes while the app is open.
  const runFeedRefresh = useCallback(async (force = false) => {
    try {
      await refreshAll({ force, intervalMin: 30, onProgress: (done, total) => setFeedProgress(total ? { done, total } : null) });
      setLastFeedRefresh(Date.now());
    } catch {
      /* browser preview: no feeds */
    } finally {
      setFeedProgress(null);
    }
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => runFeedRefresh(), 2500);
    const timer = window.setInterval(() => runFeedRefresh(), 30 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [runFeedRefresh]);
  useEffect(() => {
    feedsApi.unread().then(setUnread).catch(() => {});
  }, [feedsVersion]);

  // Browser bookmarklet (marginalia://clip?url=…), at launch or while running.
  useEffect(() => {
    let off = () => {};
    listenForClips((url) => setClip({ url, auto: true })).then((f) => (off = f));
    return () => off();
  }, []);

  // Pasting a link anywhere on the library starts a clip.
  useEffect(() => {
    if (openId) return;
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as Element)?.closest?.("input, textarea, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (looksLikeUrl(text)) {
        e.preventDefault();
        setClip({ url: text.trim(), auto: true });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [openId]);

  /** Put a clipped article on the shelf (no navigation). */
  const addClipToLibrary = async (r: ClipResult, url: string, hints?: { title?: string; siteName?: string; interests?: string[] }) => {
    let rec = booksRef.current.find((b) => b.id === r.id);
    if (!rec) {
      let meta = r.meta;
      if (!meta) {
        // Snapshot exists on disk but not in the library (e.g. removed from shelf earlier): read its metadata.
        try {
          const doc = new DOMParser().parseFromString(new TextDecoder().decode(await readBook(r.id, "html")), "text/html");
          const m = (k: string) => doc.querySelector(`meta[name="marginalia:${k}"]`)?.getAttribute("content") ?? "";
          const published = Date.parse(m("published"));
          meta = {
            title: hints?.title || doc.title || url,
            author: m("author"),
            siteName: hints?.siteName || m("site"),
            excerpt: m("excerpt"),
            publishedAt: Number.isNaN(published) ? undefined : published,
            sourceUrl: m("source") || url,
          };
        } catch {
          meta = { title: url, author: "", siteName: "", excerpt: "", sourceUrl: url };
        }
      }
      rec = {
        id: r.id,
        ext: "html",
        format: "html",
        title: meta.title,
        author: meta.author,
        fileName: r.fileName || "article.html",
        size: r.size,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        progress: 0,
        annotationCount: 0,
        sourceUrl: meta.sourceUrl,
        siteName: meta.siteName,
        publishedAt: meta.publishedAt,
        excerpt: meta.excerpt,
        // A subscription article starts with its source's reading interests.
        interests: hints?.interests?.length ? [...hints.interests] : undefined,
      };
      booksRef.current = [...booksRef.current, rec];
      setBooks(booksRef.current);
    }
    return rec;
  };

  const finishClip = async (r: ClipResult, url: string) => {
    setClip(null);
    const rec = await addClipToLibrary(r, url);
    // Hand-saved articles also live in the subscriptions inbox ("手动添加"), next to the feeds.
    recordManualArticle({ id: rec.id, url: rec.sourceUrl ?? url, title: rec.title, author: rec.author, summary: rec.excerpt }).catch(() => {});
    if (r.existed) notify("这篇文章之前已经保存过，已为你打开");
    else if (r.imagesFailed) notify(`已保存。有 ${r.imagesFailed} 张图片未能下载，联网时仍会尝试显示。`);
    setFocusNoteId(null);
    updateBook(r.id, { lastOpenedAt: Date.now() });
    setOpenId(r.id);
  };

  /** Inbox → library, silently (keep triaging). */
  const saveFeedItem = async (item: FeedItem, sourceTitle?: string, interests?: string[]) => {
    try {
      const hints = { title: item.title || undefined, siteName: sourceTitle, interests };
      const r = await clipArticle(item.url, () => {}, hints);
      const rec = await addClipToLibrary(r, item.url, hints);
      notify(r.existed ? `《${rec.title}》已在书架中` : `已保存《${rec.title}》到书架${r.imagesFailed ? `（${r.imagesFailed} 张图片未能下载）` : ""}`);
      return rec.id;
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const openNote = (hit: NoteHit) => {
    setFocusNoteId(hit.note.id);
    updateBook(hit.bookId, { lastOpenedAt: Date.now() });
    setOpenId(hit.bookId);
  };

  // The reading-font pairing is shared by the reader and the article lists / previews / reviews.
  useEffect(() => {
    document.documentElement.style.setProperty("--read-font", bodyFont(settings));
  }, [settings.font, settings.fontEn]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => scheduleMdBackup(() => booksRef.current), []);

  const pick = async () => importItems(await pickFiles());

  const removeBook = async (b: BookRecord) => {
    const n = counts[b.id] ?? 0;
    const msg = n ? `从书库移除《${b.title}》？它的 ${n} 条笔记也会被删除。` : `从书库移除《${b.title}》？`;
    if (!(await confirmDialog(msg))) return;
    await deleteBook(b.id, b.ext).catch(() => {});
    await notesStore.removeBook(b.id);
    // Web articles also live in the subscriptions inbox: remove them there too.
    await feedsApi.unsave(b.id).catch(() => {});
    feedsChanged();
    setBooks((list) => list.filter((x) => x.id !== b.id));
  };

  const openBook = books.find((b) => b.id === openId) ?? null;

  // One window zoom, two remembered values: one while reading, one for the shelf / notes / explore pages.
  const reading = !!openBook;
  useEffect(() => void setViewZoom(reading ? settings.zoom : settings.libZoom), [reading, settings.zoom, settings.libZoom]);
  const libZoomHint = useZoomControls(!reading, settings.libZoom, (libZoom) => updateSettings({ libZoom }));

  return (
    <>
      {openBook ? (
        <Reader
          key={openBook.id}
          book={openBook}
          openAtNoteId={focusNoteId}
          settings={settings}
          onSettings={updateSettings}
          onBookUpdate={updateBook}
          onClose={() => {
            setOpenId(null);
            setFocusNoteId(null);
          }}
          onError={notify}
        />
      ) : (
        <Library
          books={books}
          counts={counts}
          docCounts={docCounts}
          view={view}
          onView={setView}
          onOpenNote={openNote}
          onClip={() => setClip({})}
          onSettings={() => setShowSettings(true)}
          onUpdateBook={updateBook}
          unread={unread}
          feedProgress={feedProgress}
          lastFeedRefresh={lastFeedRefresh}
          onRefreshFeeds={() => runFeedRefresh(true)}
          onSaveFeedItem={saveFeedItem}
          onOpenBookId={(id) => {
            updateBook(id, { lastOpenedAt: Date.now() });
            setOpenId(id);
          }}
          notify={notify}
          theme={settings.theme}
          busy={busy}
          onImport={pick}
          onOpen={(b) => {
            updateBook(b.id, { lastOpenedAt: Date.now() });
            setOpenId(b.id);
          }}
          onRemove={removeBook}
        />
      )}
      {dragOver && (
        <div className={`drop-zone theme-${settings.theme}`}>
          <div>松开以导入</div>
        </div>
      )}
      {clip && <ClipDialog initialUrl={clip.url} autoStart={clip.auto} onDone={finishClip} onClose={() => setClip(null)} />}
      {showSettings && <SettingsDialog settings={settings} books={books} onChange={updateSettings} onClose={() => setShowSettings(false)} notify={notify} />}
      {libZoomHint && !reading && <div className="zoom-hint lib">{Math.round(settings.libZoom * 100)}%</div>}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
