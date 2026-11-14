import { useCallback, useEffect, useRef, useState } from "react";
import { isFreeNote, type BookRecord } from "./core/types";
import { formatOf } from "./core/formats";
import { openBook as openBookDoc } from "./openBook";
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
  FIRST_RUN,
  markFirstRunDone,
  maximizeWindow,
  setWindowTitle,
  settingsStore,
  type ImportedBook,
} from "./platform";
import { DEFAULT_SETTINGS, autoZoomFor, bodyFont, normalizeSettings, type Settings } from "./settings";
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
import { brandName, resolveLang, setLang, t } from "./i18n";
import { localizeErr } from "./i18n/errors";
import { recordGoalSnaps } from "./tasks/snaps";
import { ensureReviewItems } from "./review/engine";
import { Palette } from "./palette/Palette";
import { syncIndex } from "./search/indexer";
import "./trash/notes";
import { trashStore } from "./trash/store";
import { ConfirmHost, ToastHost } from "./trash/ui";
import { QuickCapture, type CaptureKind } from "./palette/QuickCapture";
import type { Actions } from "./palette/commands";
import type { Tab as SettingsTab } from "./components/SettingsDialog";
import { toggleCard } from "./cards/windows";
import { NAV_EVENT, type NavTarget } from "./cards/nav";
import { startSync } from "./cards/sync";
import { anyCardOn } from "./cards/state";
import { restoreCards } from "./cards/windows";
import { rebuildTray, setupTray, showMainWindow } from "./cards/tray";

export default function App() {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [focusText, setFocusText] = useState<{ section: number; text: string; snippet?: string } | null>(null);
  const [view, setView] = useState<"shelf" | "feeds" | "notes" | "tasks">("notes");
  const [feedProgress, setFeedProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastFeedRefresh, setLastFeedRefresh] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);
  const feedsVersion = useFeedsVersion();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});
  const [clip, setClip] = useState<{ url?: string; auto?: boolean } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [capture, setCapture] = useState<CaptureKind | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const notesVersion = useNotesVersion();
  const [settings, setSettings] = useState<Settings>(() => {
    const s = normalizeSettings(settingsStore.load(DEFAULT_SETTINGS));
    if (!FIRST_RUN || !isTauri) return s;
    // first launch of a fresh install: scale the pages to the screen (the reading view a little less)
    const z = autoZoomFor(window.screen.availWidth, window.screen.availHeight);
    return { ...s, libZoom: z, zoom: Math.min(z, 1.3) };
  });
  // the recycle bin keeps things for 30 days: sweep what is older, a little after start and then every few hours
  useEffect(() => {
    const run = () => void trashStore.purgeOld().catch(() => {});
    const first = window.setTimeout(run, 8000);
    const iv = window.setInterval(run, 6 * 3600 * 1000);
    return () => (window.clearTimeout(first), window.clearInterval(iv));
  }, []);
  // keep the index of the books' text in line with the shelf (in the background, a few seconds after the shelf changes)
  const shelfKey = books.map((b) => b.id).join("|");
  useEffect(() => {
    if (settings.bookSearch === false || !books.length) return;
    const id = window.setTimeout(() => void syncIndex(books), 4000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.bookSearch, shelfKey]);
  // keep the note-review schedule filled: shortly after start, then every ten minutes
  useEffect(() => {
    const run = () => void ensureReviewItems().catch(() => {});
    const first = window.setTimeout(run, 5000);
    const iv = window.setInterval(run, 10 * 60 * 1000);
    return () => (window.clearTimeout(first), window.clearInterval(iv));
  }, []);
  useEffect(() => {
    if (!FIRST_RUN) return;
    void maximizeWindow();
    markFirstRunDone();
  }, []);
  // The language is applied while rendering (quietly): everything below re-renders with this component anyway.
  setLang(resolveLang(settings.lang), true);
  const [busy, setBusy] = useState(false);
  const [importPct, setImportPct] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const booksRef = useRef(books);
  booksRef.current = books;
  const loaded = useRef(false);

  const notify = useCallback((raw: string) => {
    const msg = localizeErr(raw); // sentences from the Rust side arrive in Chinese: show them in the current language
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4200);
  }, []);

  useEffect(() => {
    loadLibrary().then(
      (b) => {
        setBooks(b);
        loaded.current = true;
      },
      // not read: leave `loaded` false, so the (empty) shelf on screen is never saved over the real one
      (e) => notify(t("app.libraryFail", { err: String(e) })),
    );
  }, []);

  // Persist the library index (debounced; progress updates arrive often).
  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => saveLibrary(books).catch((e) => notify(t("app.saveFail", { err: String(e) }))), 500);
    return () => clearTimeout(timer);
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
  // Big files are copied in the background; the Rust side reports how far it got.
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ done: number; total: number }>("import-progress", (e) => {
        const { done, total } = e.payload;
        setImportPct(total && done < total ? Math.floor((done / total) * 100) : null);
      }).then((f) => (off = f)),
    );
    return () => off?.();
  }, []);

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
          if (!format) throw new Error(t("app.unsupported", { ext: imp.ext }));
          const existing = booksRef.current.find((b) => b.id === imp.id);
          if (!existing) {
            let title = imp.fileName.replace(/\.[^.]+$/, "");
            let author = "";
            try {
              const doc = await openBookDoc(imp);
              title = doc.title || title;
              author = doc.author;
              doc.destroy();
            } catch (e) {
              throw new Error(t("app.corrupt", { err: e instanceof Error ? e.message : String(e) }));
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
          notify(t("app.importFail", { name, err: e instanceof Error ? e.message : String(e) }));
        }
      }
      setBusy(false);
      if (opened.length === 1) setOpenId(opened[0]);
      else if (opened.length > 1) notify(t("app.imported", { n: opened.length }));
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
    if (r.existed) notify(t("app.alreadySaved"));
    else if (r.imagesFailed) notify(t("app.savedImgFail", { n: r.imagesFailed }));
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
      notify(r.existed ? t("app.alreadyOnShelf", { title: rec.title }) : t("app.savedToShelf", { title: rec.title }) + (r.imagesFailed ? t("app.savedImgPart", { n: r.imagesFailed }) : ""));
      return rec.id;
    } catch (e) {
      notify(t("app.saveArticleFail", { err: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  };

  const openNote = (hit: NoteHit) => {
    setFocusText(null);
    setFocusNoteId(hit.note.id);
    updateBook(hit.bookId, { lastOpenedAt: Date.now() });
    setOpenId(hit.bookId);
  };

  // The reading-font pairing is shared by the reader and the article lists / previews / reviews.
  useEffect(() => {
    document.documentElement.style.setProperty("--read-font", bodyFont(settings));
  }, [settings.font, settings.fontEn]);

  // once the data is in, and then every half hour: note how far each goal is (the weekly review shows the change)
  useEffect(() => {
    const run = () => void recordGoalSnaps().catch(() => {});
    const first = window.setTimeout(run, 4000);
    const again = window.setInterval(run, 30 * 60 * 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, []);

  const uiLang = resolveLang(settings.lang);
  useEffect(() => {
    void setWindowTitle(brandName());
    if (isTauri) void rebuildTray();
  }, [uiLang]);

  // Desktop: tray icon, desktop cards, closing to the tray while cards are open, and clicks on a card
  const navRef = useRef<(t: NavTarget) => void>(() => {});
  navRef.current = async (target) => {
    await showMainWindow();
    setOpenId(null);
    if (target.to === "notes") setView("notes");
    else if (target.to === "note") {
      const [hit] = await notesStore.byIds([target.id]);
      if (hit && !isFreeNote(hit.note)) openNote(hit);
      else setView("notes");
    } else {
      (window as unknown as { __tasksNav?: NavTarget }).__tasksNav = target;
      setView("tasks");
      window.dispatchEvent(new Event("reader:tasks-nav"));
    }
  };
  useEffect(() => {
    if (!isTauri) return;
    const offs: (() => void)[] = [];
    let gone = false;
    (async () => {
      offs.push(await startSync());
      await setupTray(() => void showMainWindow());
      await restoreCards();
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { listen } = await import("@tauri-apps/api/event");
      const win = getCurrentWindow();
      offs.push(
        await win.onCloseRequested(async (e) => {
          if (anyCardOn()) {
            e.preventDefault();
            await win.hide();
          }
        }),
      );
      offs.push(await listen<NavTarget>(NAV_EVENT, (e) => navRef.current(e.payload)));
      if (gone) offs.forEach((f) => f());
    })();
    return () => {
      gone = true;
      offs.forEach((f) => f());
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => scheduleMdBackup(() => booksRef.current), []);

  const pick = async () => importItems(await pickFiles());

  const removeBook = async (b: BookRecord) => {
    const n = counts[b.id] ?? 0;
    const msg = n ? t("app.removeConfirmNotes", { title: b.title, n }) : t("app.removeConfirm", { title: b.title });
    if (!(await confirmDialog(msg))) return;
    await deleteBook(b.id, b.ext).catch(() => {});
    await notesStore.removeBook(b.id);
    // Web articles also live in the subscriptions inbox: remove them there too.
    await feedsApi.unsave(b.id).catch(() => {});
    feedsChanged();
    setBooks((list) => list.filter((x) => x.id !== b.id));
  };

  const openBook = books.find((b) => b.id === openId) ?? null;

  // Ctrl + K palette: what its commands can do to the app
  const paletteActions: Actions = {
    desktop: isTauri,
    view: (v) => (setOpenId(null), setView(v)),
    settings: (tab) => (setSettingsTab(tab), setShowSettings(true)),
    importDocs: () => void pick(),
    clip: () => setClip({}),
    toggleTheme: () => updateSettings({ theme: settings.theme === "dark" ? "paper" : "dark" }),
    lang: (l) => updateSettings({ lang: l }),
    card: (k) => void toggleCard(k),
    capture: (kind) => {
      // a box for it is already on screen: use that one; otherwise a small window over whatever you are doing
      const sel = kind === "note" ? ".memo-input textarea, .memo-input [contenteditable], textarea.memo-input" : ".task-quick input";
      const el = openId ? null : document.querySelector<HTMLElement>(sel);
      if (el) {
        if (kind === "note") window.dispatchEvent(new Event("reader:memo-clear"));
        el.focus();
      } else setCapture(kind);
    },
  };
  const openBookAt = (id: string, target: { section: number; text: string; snippet?: string }) => {
    updateBook(id, { lastOpenedAt: Date.now() });
    setFocusText(target);
    setOpenId(id);
  };
  const openTaskFromPalette = (id: string) => {
    setOpenId(null);
    (window as unknown as { __tasksNav?: NavTarget }).__tasksNav = { to: "task", id };
    setView("tasks");
    window.dispatchEvent(new Event("reader:tasks-nav"));
  };

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
          openAtText={focusText}
          settings={settings}
          onSettings={updateSettings}
          onBookUpdate={updateBook}
          onClose={() => {
            setOpenId(null);
            setFocusNoteId(null);
            setFocusText(null);
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
          onSettings={() => (setSettingsTab(undefined), setShowSettings(true))}
          onUpdateBook={updateBook}
          unread={unread}
          feedProgress={feedProgress}
          lastFeedRefresh={lastFeedRefresh}
          onRefreshFeeds={() => runFeedRefresh(true)}
          onSaveFeedItem={saveFeedItem}
          onOpenBookAt={openBookAt}
          bookSearch={settings.bookSearch}
          onOpenBookId={(id) => {
            updateBook(id, { lastOpenedAt: Date.now() });
            setFocusText(null);
            setOpenId(id);
          }}
          notify={notify}
          theme={settings.theme}
          busy={busy}
          importPct={importPct}
          onImport={pick}
          onOpen={(b) => {
            updateBook(b.id, { lastOpenedAt: Date.now() });
            setFocusText(null);
            setOpenId(b.id);
          }}
          onRemove={removeBook}
        />
      )}
      {dragOver && (
        <div className={`drop-zone theme-${settings.theme}`}>
          <div>{t("app.dropToImport")}</div>
        </div>
      )}
      <ToastHost />
      <ConfirmHost onNeverAsk={() => updateSettings({ confirmDelete: false })} />
      {capture && <QuickCapture kind={capture} onClose={() => setCapture(null)} notify={notify} />}
      <Palette
        books={books}
        actions={paletteActions}
        onOpenBook={(id) => {
          updateBook(id, { lastOpenedAt: Date.now() });
          setFocusText(null);
          setOpenId(id);
        }}
        onOpenNote={openNote}
        onOpenBookAt={openBookAt}
        bookSearch={settings.bookSearch !== false}
        onOpenTask={openTaskFromPalette}
        notify={notify}
        shortcuts={settings.shortcuts}
      />
      {clip && <ClipDialog initialUrl={clip.url} autoStart={clip.auto} onDone={finishClip} onClose={() => setClip(null)} />}
      {showSettings && <SettingsDialog key={settingsTab ?? "default"} initialTab={settingsTab} settings={settings} books={books} onChange={updateSettings} onClose={() => setShowSettings(false)} notify={notify} />}
      {libZoomHint && !reading && <div className="zoom-hint lib">{Math.round(settings.libZoom * 100)}%</div>}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
