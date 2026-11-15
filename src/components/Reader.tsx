import { clearReveal, revealActive, revealCount, revealText } from "../search/reveal";
import { SlotHost } from "../host/SlotHost";
import { anchorOfRef, noteOrigin } from "../host/refs";
import { docProvider, moduleOfDoc } from "../host/registry";
import { bookIndex, type TextHit } from "../search/backend";
import { FindPanel } from "../search/FindPanel";
import { askDeleteNote, reportDeleted } from "../trash/delete";
import { confirmTrash, toast } from "../trash/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxSelect, ChevronLeft, Download, ExternalLink, List, NotebookPen, StickyNote, Type, X } from "lucide-react";
import { DOC_ANCHOR, isDocNote, type Annotation, type BookRecord, type HighlightStyle, type LoadedDoc, type TextAnchor, type TocItem } from "../core/types";
import { openBook } from "../openBook";
import { describe, resolve } from "../core/anchor";
import { isMostlyLatin } from "../core/lang";
import { charBoxes, hitTest, lineBoxes, type Box } from "../core/rects";
import { regionPath, shapesFor } from "../core/draw";
import { contrastFrame } from "../core/contrast";
import { PICTURE_SELECTOR, parseSizeKey, pictureElements, pictureHref, pictureRect, sizeKey } from "../core/picture";
import { swatch } from "../core/palette";
import { computeStage, layoutCards, minStageWidth, type CardInput } from "../core/layout";
import { openExternal, exportTextFile, fetchImage, isTauri } from "../platform";
import { useZoomControls } from "../useZoom";
import { imageEmbeds, imageIdsOf } from "../notes/query";
import { notesStore, type NoteHit } from "../notes/store";
import { parseTags } from "../notes/tags";
import { putImage } from "../notes/images";
import { EMPTY_FILTER, NotesBrowser, type NotesFilter } from "./NotesBrowser";
import { bodyFont, type Settings } from "../settings";
import { NoteCard } from "./NoteCard";
import { DocNotes, ReadingMeta } from "./DocNotes";
import { ReadingStats } from "../reading/ReadingStats";
import { useReadingTracker } from "../reading/tracker";
import { SelectionToolbar } from "./SelectionToolbar";
import { SettingsPanel, TocPanel } from "./Panels";
import { t } from "../i18n";
import { fmtDateTime } from "../i18n";

interface Props {
  book: BookRecord;
  /** Open the book at this note (coming from the notes hub). */
  openAtNoteId?: string | null;
  /** Open the book at this passage (coming from a search in the books' text). */
  openAtText?: { section: number; text: string; snippet?: string } | null;
  /** A place inside a module's document (a chapter, a verse): the reader goes there once the text is laid out. */
  openAtRef?: { section: number; fragment?: string; seq: number } | null;
  settings: Settings;
  onSettings(p: Partial<Settings>): void;
  onBookUpdate(id: string, p: Partial<BookRecord>): void;
  onClose(): void;
  onError(msg: string): void;
}

interface Sel {
  anchor: TextAnchor;
  x: number;
  y: number;
  below: boolean;
}

/** The picture a region belongs to: the same position in the section, checked by its natural size (when known). */
function findImage(root: HTMLElement | null, ref: { index: number; key: string }): Element | null {
  if (!root?.isConnected) return null;
  const pics = pictureElements(root);
  const sizeOf = (i: Element) => (i instanceof HTMLImageElement ? `${i.naturalWidth}x${i.naturalHeight}` : null);
  const at = pics[ref.index];
  if (at) {
    const k = sizeOf(at);
    if (!k || k === "0x0" || k === ref.key) return at; // not loaded yet (or an SVG picture): trust the position
  }
  return pics.find((i) => sizeOf(i) === ref.key) ?? null;
}

interface Geometry {
  boxes: Map<string, Box[]>;
  ys: Map<string, number>;
  /** Per-character boxes, only for styles that need them (着重号). */
  chars: Map<string, Box[]>;
}

type Loc = { section: number; ratio: number };

const nodeEl = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement!);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CARD_GAP = 10;
/** Id of the pinned 整体笔记 card in the margin layout. */
const DOC_CARD = "__doc__";
const MARKER_GUTTER = 18;

export function Reader({ book, openAtNoteId, openAtText, openAtRef, settings, onSettings, onBookUpdate, onClose, onError }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [geo, setGeo] = useState<Geometry>({ boxes: new Map(), ys: new Map(), chars: new Map() });
  const [stageH, setStageH] = useState(0);
  const [avail, setAvail] = useState(() => window.innerWidth);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  /** PDF: drag a box on the page (always on for pages without text; elsewhere with this tool or Alt + drag). */
  const [regionTool, setRegionTool] = useState(false);
  const [draft, setDraft] = useState<Box | null>(null);
  const regionToolRef = useRef(false);
  regionToolRef.current = regionTool;
  const regionSelRef = useRef(false);
  const [panel, setPanel] = useState<"notes" | "doc" | "settings" | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [notesFilter, setNotesFilter] = useState<NotesFilter>({ ...EMPTY_FILTER, sort: "position" });
  const pendingFocus = useRef<string | null>(openAtNoteId ?? null);
  const pendingText = useRef(openAtText ?? null);
  const pendingRef = useRef(openAtRef ?? null);
  const shownRef = useRef(openAtRef ?? null);
  const shownText = useRef(openAtText ?? null);
  // a PDF draws a page's text only when it is near the screen: the boxes follow as the pages appear
  const pdfSearch = useRef<{ section: number; text: string; snippet?: string; first: boolean } | null>(null);
  const pdfTimer = useRef(0);
  const pdfPageReady = (i: number, d: LoadedDoc) => {
    const s = pdfSearch.current;
    if (!s) return;
    if (s.first && i !== s.section) return;
    if (!s.first && !revealActive()) {
      pdfSearch.current = null; // the boxes were put away: stop following
      return;
    }
    window.clearTimeout(pdfTimer.current);
    pdfTimer.current = window.setTimeout(() => {
      const first = s.first;
      s.first = false;
      const all = Array.from({ length: d.sectionCount() }, (_, k) => d.sectionRoot(k));
      if (!revealText(all, s.section, s.text, s.snippet, { scroll: first }) && first) toast(t("th.notFound"));
    }, s.first ? 60 : 160);
  };
  /** Go to a found place: at once when its page is drawn, otherwise scroll to the page and box it when it appears. */
  const goToText = (target: { section: number; text: string; snippet?: string }, d: LoadedDoc) => {
    if (d.format === "pdf" && !d.sectionRoot(target.section)) {
      pdfSearch.current = { ...target, first: true };
      d.locate(target.section)?.scrollIntoView();
      return;
    }
    if (d.format === "pdf") pdfSearch.current = { ...target, first: false };
    const all = Array.from({ length: d.sectionCount() }, (_, k) => d.sectionRoot(k));
    if (!revealText(all, target.section, target.text, target.snippet)) toast(t("th.notFound"));
  };
  // every place the searched words appear in this book, listed beside the page
  const [find, setFind] = useState<{ text: string; hits: TextHit[]; current: number; truncated: boolean } | null>(null);
  const openFind = async (target: { section: number; text: string; snippet?: string }) => {
    try {
      const f = await bookIndex.search(target.text, 200, 1, [book.id]);
      if (f.hits.length < 2) return setFind(null);
      let cur = f.hits.findIndex((h) => h.section === target.section && (!target.snippet || h.snippet === target.snippet));
      if (cur < 0) cur = f.hits.findIndex((h) => h.section === target.section);
      setFind({ text: target.text, hits: f.hits, current: Math.max(0, cur), truncated: f.hits.length >= 200 });
      window.setTimeout(() => setFind((x) => (x ? { ...x } : x)), 600); // the boxes are drawn a moment later: show their total
    } catch {
      setFind(null);
    }
  };
  const roots = () => (doc ? Array.from({ length: doc.sectionCount() }, (_, i) => doc.sectionRoot(i)) : []);
  const pickHit = (i: number) => {
    if (!doc || !find) return;
    const h = find.hits[i];
    setFind({ ...find, current: i });
    goToText({ section: h.section, text: find.text, snippet: h.snippet }, doc);
  };
  const sectionTitle = (s: number) => {
    let best = "";
    const walk = (items: { label: string; section: number; children?: unknown[] }[]) =>
      items.forEach((it) => {
        if (it.section <= s && it.section >= 0) best = it.label;
        if (it.children?.length) walk(it.children as typeof items);
      });
    walk((doc?.toc ?? []) as { label: string; section: number; children?: unknown[] }[]);
    return best || t(doc?.format === "pdf" ? "th.page" : "th.section", { n: s + 1 });
  };
  useEffect(() => {
    if (!find) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "F3") (e.preventDefault(), pickHit((find.current + (e.shiftKey ? -1 : 1) + find.hits.length) % find.hits.length));
      else if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) (setFind(null), clearReveal());
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find]);
  // a module asks for a note on a whole verse (from its verse bubble)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ docId: string; ref: string }>).detail;
      const document_ = docRef.current;
      if (d.docId !== book.id || !document_) return;
      const anchor = anchorOfRef(document_, d.ref);
      if (anchor) createFromAnchor(anchor, settings.lastColor, settings.lastStyle, true);
    };
    window.addEventListener("reader:make-verse-note", on);
    return () => window.removeEventListener("reader:make-verse-note", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, settings.lastColor, settings.lastStyle]);

  /** Scroll to a place in a module's document and mark it for a moment. */
  const goToPlace = (p: { section: number; fragment?: string }) => {
    const d = docRef.current;
    const sc = scrollerRef.current;
    const el = d?.locate(p.section, p.fragment);
    if (!d || !sc || !el) return;
    sc.scrollTop = topOf(el) - 120;
    const mark = (el.closest("[data-ref]") ?? el) as HTMLElement;
    mark.classList.add("ref-flash");
    window.setTimeout(() => mark.classList.remove("ref-flash"), 2200);
  };
  // a place asked for in a document that is already open
  useEffect(() => {
    if (!openAtRef || openAtRef === shownRef.current || !doc) return;
    shownRef.current = openAtRef;
    goToPlace(openAtRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAtRef, doc]);
  // searching again for a passage of the book that is already open
  useEffect(() => {
    if (!openAtText || openAtText === shownText.current || !doc) return;
    shownText.current = openAtText;
    // no scrolling to the section first: when the words are already on the page nothing should move at all
    goToText(openAtText, doc);
    void openFind(openAtText);
  }, [openAtText, doc]);
  const [progress, setProgress] = useState(book.progress);
  useReadingTracker(book.id, progress, settings.readingTrack !== false, settings.readingIdle ?? 90);
  const [currentSection, setCurrentSection] = useState(book.location?.section ?? 0);
  /** English (Latin-script) books are typeset with English rules: inter-word justification, hyphenation. */
  const [isEn, setIsEn] = useState(false);

  // Refs mirror state for event handlers / rAF callbacks.
  const docRef = useRef(doc);
  docRef.current = doc;
  const annRef = useRef(annotations);
  annRef.current = annotations;
  const dirty = useRef(false);
  const locRef = useRef<Loc | null>(book.location ?? null);

  const isPdf = book.format === "pdf";
  const dark = settings.theme === "dark";
  const shownTitle = book.origTitle ? book.title : (doc?.title ?? book.title);
  const fontPx = isPdf ? 14 : settings.fontSize;
  const L = computeStage(avail, doc?.preferredWidth ?? (isPdf ? 860 : 680), isPdf ? 16 : settings.fontSize, settings.layout);
  const showMargins = !L.immersive && L.mode !== "compact";
  const showMarkers = !L.immersive && L.mode === "compact";
  const contentX = showMargins && L.mode === "dual" ? L.margin + L.gap : 0;
  const rightX = contentX + L.content + L.gap;
  const stageW = L.total + (showMarkers ? MARKER_GUTTER : 0);
  const contentWidthRef = useRef(L.content);
  contentWidthRef.current = L.content;

  // ---------- geometry ----------
  const geoRaf = useRef(0);
  const computeGeometry = useCallback(() => {
    const d = docRef.current;
    const stage = stageRef.current;
    if (!d || !stage) return;
    const origin = stage.getBoundingClientRect();
    const boxes = new Map<string, Box[]>();
    const ys = new Map<string, number>();
    const chars = new Map<string, Box[]>();
    for (const a of annRef.current) {
      if (isDocNote(a)) continue;
      if (a.anchor.region) {
        // A boxed area: the rectangle of the page (PDF) or of the picture (reflowing documents) × the stored fractions.
        const pageEl = a.anchor.image ? findImage(d.sectionRoot(a.anchor.section), a.anchor.image) : d.locate(a.anchor.section);
        if (pageEl?.isConnected) {
          const pr = a.anchor.image ? pictureRect(pageEl, parseSizeKey(a.anchor.image.key)) : pageEl.getBoundingClientRect();
          const g = a.anchor.region;
          const b = { x: pr.left - origin.left + g.x * pr.width, y: pr.top - origin.top + g.y * pr.height, w: g.w * pr.width, h: g.h * pr.height };
          boxes.set(a.id, [b]);
          ys.set(a.id, b.y);
        }
        continue;
      }
      const root = d.sectionRoot(a.anchor.section);
      const range = root?.isConnected ? resolve(a.anchor, root) : null;
      if (range) {
        const b = lineBoxes(range, origin);
        if (b.length) {
          boxes.set(a.id, b);
          if (a.style === "emphasis") chars.set(a.id, charBoxes(range, origin));
          ys.set(a.id, b[0].y);
          continue;
        }
      }
      const el = d.locate(a.anchor.section);
      if (el?.isConnected) ys.set(a.id, el.getBoundingClientRect().top - origin.top);
    }
    setGeo({ boxes, ys, chars });
    setStageH(stage.offsetHeight);
  }, []);
  const scheduleGeometry = useCallback(() => {
    cancelAnimationFrame(geoRaf.current);
    geoRaf.current = requestAnimationFrame(computeGeometry);
  }, [computeGeometry]);

  // ---------- location ----------
  const topOf = (el: Element) => {
    const sc = scrollerRef.current!;
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };
  const readLocation = (): Loc | null => {
    const d = docRef.current;
    const sc = scrollerRef.current;
    if (!d || !sc || !d.sectionCount()) return null;
    const y = sc.scrollTop + 80;
    let lo = 0;
    let hi = d.sectionCount() - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = d.locate(mid);
      if (!el) break;
      if (topOf(el) <= y) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const el = d.locate(ans)!;
    const h = Math.max(1, (el as HTMLElement).offsetHeight);
    return { section: ans, ratio: Math.min(1, Math.max(0, (y - topOf(el)) / h)) };
  };
  const scrollToLocation = (loc: Loc | null) => {
    const el = loc && docRef.current?.locate(loc.section);
    const sc = scrollerRef.current;
    if (!el || !sc) return;
    sc.scrollTop = topOf(el) + loc.ratio * (el as HTMLElement).offsetHeight - 80;
  };
  const goTo = useCallback((section: number, fragment?: string) => {
    const el = docRef.current?.locate(section, fragment);
    const sc = scrollerRef.current;
    if (!el || !sc) return;
    sc.scrollTop = topOf(el) - 72;
    setPanel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- load + mount ----------
  useEffect(() => {
    let cancelled = false;
    let loaded: LoadedDoc | null = null;
    (async () => {
      try {
        const [opened, anns] = await Promise.all([openBook(book), notesStore.forBook(book.id)]);
        loaded = opened;
        if (cancelled) return opened.destroy();
        setAnnotations(anns);
        if (cancelled) return loaded.destroy();
        setDoc(loaded);
        // A title the user typed in (origTitle is set) is never overwritten by the file's own title.
        const title = book.origTitle ? book.title : loaded.title;
        if (title !== book.title || loaded.author !== book.author) onBookUpdate(book.id, { title, author: loaded.author });
      } catch (e) {
        onError(t("rd.openFail", { title: book.title, err: e instanceof Error ? e.message : String(e) }));
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    if (!doc || !hostRef.current) return;
    const focusNote = pendingFocus.current ? annRef.current.find((a) => a.id === pendingFocus.current) : undefined;
    const restore = focusNote && !isDocNote(focusNote) ? { section: focusNote.anchor.section, ratio: 0 } : pendingRef.current ? { section: pendingRef.current.section, ratio: 0 } : pendingText.current ? { section: pendingText.current.section, ratio: 0 } : book.location;
    let restored = !restore || doc.format === "pdf";
    if (doc.format === "pdf" && pendingText.current) {
      const target = pendingText.current;
      pdfSearch.current = { ...target, first: true };
      pendingText.current = null;
      void openFind(target);
    }
    doc
      .mount(hostRef.current, {
        width: contentWidthRef.current,
        onSectionReady: (i) => {
          if (doc.format === "pdf") pdfPageReady(i, doc);
          if (doc.format === "pdf") {
            // Pages without a text layer (scans) are boxed with a plain drag.
            const pageEl = doc.locate(i) as HTMLElement | null;
            pageEl?.classList.toggle("no-text", !doc.sectionRoot(i)?.querySelector("span"));
          }
          if (!restored && restore && i >= restore.section) {
            restored = true;
            scrollToLocation(restore);
            setLoading(false);
          } else if (restored) setLoading(false);
          scheduleGeometry();
        },
        onNavigate: goTo,
      })
      .then(() => {
        if (doc.format === "pdf") scrollToLocation(restore ?? null);
        else {
          let sample = "";
          for (let i = 0; i < Math.min(doc.sectionCount(), 6) && sample.length < 4000; i++) sample += doc.sectionRoot(i)?.textContent?.slice(0, 1500) ?? "";
          setIsEn(isMostlyLatin(sample));
        }
        setLoading(false);
        scheduleGeometry();
        void addForeign(doc).catch(() => {});
        const place = pendingRef.current;
        if (place) {
          pendingRef.current = null;
          requestAnimationFrame(() => requestAnimationFrame(() => goToPlace(place)));
        }
        const target = pendingText.current;
        if (target && doc.format !== "pdf") {
          pendingText.current = null;
          const show = () => {
            if (!revealText(roots(), target.section, target.text, target.snippet)) toast(t("th.notFound"));
          };
          void openFind(target);
          window.setTimeout(show, 350);
          // pictures and fonts arriving shift the page a little: settle once more (quietly)
          window.setTimeout(() => {
            revealText(roots(), target.section, target.text, target.snippet);
          }, 1500);
        }
      })
      .catch((e) => onError(String(e)));
    document.fonts?.ready.then(scheduleGeometry);
    const onExt = (e: Event) => openExternal((e as CustomEvent<string>).detail);
    window.addEventListener("reader:external-link", onExt);
    return () => window.removeEventListener("reader:external-link", onExt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Available width drives the margin mode; content size changes drive geometry.
  useEffect(() => {
    const sc = scrollerRef.current;
    const host = hostRef.current;
    if (!sc || !host) return;
    const ro = new ResizeObserver(() => setAvail(sc.clientWidth));
    ro.observe(sc);
    const ro2 = new ResizeObserver(scheduleGeometry);
    ro2.observe(host);
    return () => {
      ro.disconnect();
      ro2.disconnect();
    };
  }, [scheduleGeometry]);

  // Keep the reading position when typography or column width changes.
  const layoutKey = `${L.content}|${settings.fontSize}|${settings.lineHeight}|${settings.font}|${settings.indent}`;
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (!doc) return;
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const loc = locRef.current;
    void (async () => {
      await doc.relayout?.(L.content);
      scrollToLocation(loc);
      scheduleGeometry();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, doc]);

  useEffect(scheduleGeometry, [annotations, scheduleGeometry, L.mode]);

  // Switching between margin modes starts with nothing focused (avoids a surprise bottom sheet).
  const modeKey = L.immersive ? "immersive" : L.mode;
  useEffect(() => setActiveId(null), [modeKey]);

  // ---------- scroll: progress, location (the top bar stays visible) ----------
  const lastScroll = useRef(0);
  const lastSave = useRef(0);
  const scrollRaf = useRef(0);
  const persistPosition = useCallback(() => {
    const loc = locRef.current;
    const sc = scrollerRef.current;
    if (!sc || !loc) return;
    const p = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0;
    onBookUpdate(book.id, { location: loc, progress: p, lastOpenedAt: Date.now() });
  }, [book.id, onBookUpdate]);

  const onScroll = () => {
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      const sc = scrollerRef.current;
      if (!sc || loading) return;
      const top = sc.scrollTop;
      if (Math.abs(top - lastScroll.current) > 6) {
        lastScroll.current = top;
      }
      const p = sc.scrollHeight > sc.clientHeight ? top / (sc.scrollHeight - sc.clientHeight) : 0;
      setProgress((old) => (Math.abs(old - p) > 0.001 ? p : old));
      const loc = readLocation();
      if (loc) {
        locRef.current = loc;
        setCurrentSection((s) => (s === loc.section ? s : loc.section));
      }
      if (Date.now() - lastSave.current > 3000) {
        lastSave.current = Date.now();
        persistPosition();
      }
    });
  };

  // ---------- persistence ----------
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      const own = annotations.filter((a) => !foreign.current.has(a.id));
      notesStore.putBook(book.id, own).catch((e) => onError(t("rd.notesSaveFail", { err: String(e) })));
      syncForeign(annotations);
      onBookUpdate(book.id, { annotationCount: own.length });
    }, 400);
    return () => clearTimeout(timer);
  }, [annotations, book.id, onBookUpdate, onError]);

  useEffect(
    () => () => {
      if (dirty.current) {
        notesStore.putBook(book.id, annRef.current.filter((a) => !foreign.current.has(a.id))).catch(() => {});
        syncForeign(annRef.current);
      }
      persistPosition();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Notes written in another translation of the same text that are on whole verses: shown here too, but they belong to
  // the document they were written in. What is edited here is saved back there, with its own anchor.
  const foreign = useRef(new Map<string, { bookId: string; original: Annotation }>());
  const syncForeign = (list: Annotation[]) => {
    for (const [id, f] of [...foreign.current]) {
      const cur = list.find((a) => a.id === id);
      if (!cur) {
        foreign.current.delete(id);
        void notesStore.remove(f.bookId, id);
      } else if (cur.updatedAt !== f.original.updatedAt) {
        const { fromDoc: _from, ...rest } = cur;
        const saved: Annotation = { ...rest, anchor: f.original.anchor };
        foreign.current.set(id, { bookId: f.bookId, original: saved });
        void notesStore.update(f.bookId, saved);
      }
    }
  };
  const addForeign = async (d: LoadedDoc) => {
    const prefix = docProvider(book.id)?.refPrefix?.(book.id);
    if (!prefix) return;
    const mine = moduleOfDoc(book.id);
    const hits = (await notesStore.byRef(prefix)).filter((h) => h.bookId !== book.id && h.note.anchor.whole && h.note.canonicalRef && h.note.sourceModule === mine);
    const shown: Annotation[] = [];
    for (const h of hits) {
      const anchor = anchorOfRef(d, h.note.canonicalRef!);
      if (!anchor) continue;
      foreign.current.set(h.note.id, { bookId: h.bookId, original: h.note });
      shown.push({ ...h.note, anchor, fromDoc: h.bookId });
    }
    if (shown.length) setAnnotations((list) => [...list.filter((a) => !foreign.current.has(a.id)), ...shown]);
  };

  const mutate = (fn: (list: Annotation[]) => Annotation[]) => {
    dirty.current = true;
    setAnnotations(fn);
  };
  const update = (id: string, patch: Partial<Annotation>) =>
    mutate((list) =>
      list.map((a) =>
        a.id === id ? { ...a, ...patch, ...(patch.note !== undefined ? { tags: parseTags(patch.note) } : {}), updatedAt: Date.now() } : a,
      ),
    );
  /** Edits made on a card also become the default for the next highlight ("沿用最近一次选项"). */
  const editFromCard = (id: string, patch: Partial<Annotation>) => {
    update(id, patch);
    const last: Partial<Settings> = {};
    if (patch.color && patch.color !== settings.lastColor) last.lastColor = patch.color;
    if (patch.style && patch.style !== settings.lastStyle) last.lastStyle = patch.style;
    if (Object.keys(last).length) onSettings(last);
  };
  const remove = async (a: Annotation) => {
    if (!(await askDeleteNote(a.note))) return;
    mutate((list) => list.filter((x) => x.id !== a.id));
    setActiveId(null);
    reportDeleted();
  };

  // ---------- selection ----------
  const checkSelection = useCallback(() => {
    const s = window.getSelection();
    const host = hostRef.current;
    const stage = stageRef.current;
    const sc = scrollerRef.current;
    if (regionSelRef.current) return; // a boxed region is waiting for its colour / note choice
    if (!s || s.isCollapsed || !s.rangeCount || !host || !stage || !sc || !docRef.current) return setSel(null);
    const range = s.getRangeAt(0).cloneRange();
    const startEl = nodeEl(range.startContainer);
    const root = startEl && host.contains(startEl) ? startEl.closest<HTMLElement>("[data-section]") : null;
    if (!root) return setSel(null);
    // Annotations live inside one section; clamp cross-chapter/page selections.
    if (!root.contains(nodeEl(range.endContainer))) range.setEnd(root, root.childNodes.length);
    const anchor = describe(range, root, Number(root.dataset.section));
    if (!anchor || !anchor.exact.trim()) return setSel(null);
    const sr = stage.getBoundingClientRect();
    const boxes = lineBoxes(range, sr);
    if (!boxes.length) return setSel(null);
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const visibleTop = sc.getBoundingClientRect().top - sr.top;
    const below = first.y - visibleTop < 150;
    const half = Math.min(190, stage.clientWidth / 2);
    const cx = first.x + first.w / 2;
    setSel({
      anchor,
      x: Math.min(Math.max(cx, half), stage.clientWidth - half),
      y: below ? last.y + last.h + 10 : first.y - 10,
      below,
    });
  }, []);

  useEffect(() => {
    let down = false;
    let t = 0;
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element).closest?.(".sel-toolbar")) return;
      down = true;
      // A pending debounced check (e.g. from caret moves while typing a note) must not fire mid-drag,
      // or the toolbar appears for a half-made selection and then jumps when the drag ends.
      clearTimeout(t);
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      window.setTimeout(checkSelection, 10);
    };
    // Touch selection handles adjust the selection without pointer events on the content.
    const onChange = () => {
      if (down) return;
      clearTimeout(t);
      t = window.setTimeout(() => !down && checkSelection(), 280);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [checkSelection]);

  useEffect(() => {
    regionSelRef.current = !!sel?.anchor.region;
    if (!sel) setDraft(null); // the dashed outline stays until the box is turned into a note (or dismissed)
  }, [sel]);

  /** Average colour of the picture under a box → a contrasting dashed-frame colour (undefined when the pixels can't be read). */
  const sampleFrame = (base: HTMLElement, r: { x: number; y: number; w: number; h: number }, pw: number, ph: number) => {
    let src: CanvasImageSource | null = null;
    let sW = 0;
    let sH = 0;
    if (base instanceof HTMLImageElement) {
      src = base;
      sW = base.naturalWidth;
      sH = base.naturalHeight;
    } else {
      const cv = base.querySelector<HTMLCanvasElement>("canvas.pdf-canvas");
      if (cv) {
        src = cv;
        sW = cv.width;
        sH = cv.height;
      }
    }
    if (!src || !sW || !sH || !pw || !ph) return undefined;
    try {
      const N = 16;
      const c = document.createElement("canvas");
      c.width = N;
      c.height = N;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return undefined;
      g.drawImage(src, (r.x / pw) * sW, (r.y / ph) * sH, Math.max(1, (r.w / pw) * sW), Math.max(1, (r.h / ph) * sH), 0, 0, N, N);
      const px = g.getImageData(0, 0, N, N).data;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let i = 0; i < px.length; i += 4) {
        sr += px[i];
        sg += px[i + 1];
        sb += px[i + 2];
      }
      const n = px.length / 4;
      return contrastFrame(sr / n, sg / n, sb / n);
    } catch {
      return undefined; // a picture from another site: keep the default frame colour
    }
  };

  /** Crop the boxed area (out of the PDF page canvas, or the picture itself) as a picture: it stands in for the quoted text. */
  const cropThumb = async (base: HTMLElement, r: { x: number; y: number; w: number; h: number }, pw: number, ph: number) => {
    let src: CanvasImageSource | null = null;
    let sW = 0;
    let sH = 0;
    if (base instanceof HTMLImageElement) {
      src = base;
      sW = base.naturalWidth;
      sH = base.naturalHeight;
    } else {
      const cv = base.querySelector<HTMLCanvasElement>("canvas.pdf-canvas");
      if (cv) {
        src = cv;
        sW = cv.width;
        sH = cv.height;
      }
    }
    if (!src || !sW || !sH || !pw || !ph) return undefined;
    const attempt = async (from: CanvasImageSource, fW: number, fH: number) => {
      const sx = Math.round((r.x / pw) * fW);
      const sy = Math.round((r.y / ph) * fH);
      const sw = Math.max(1, Math.round((r.w / pw) * fW));
      const sh = Math.max(1, Math.round((r.h / ph) * fH));
      const k = Math.min(1, 1600 / Math.max(sw, sh));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sw * k));
      out.height = Math.max(1, Math.round(sh * k));
      const ctx = out.getContext("2d");
      if (!ctx) return undefined;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(from, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/jpeg", 0.9)); // throws for a picture from another site
      return blob ? await putImage(blob) : undefined;
    };
    try {
      return await attempt(src, sW, sH);
    } catch {
      // A web picture that was never saved locally can't be read back from the page: fetch it natively instead.
      const url = base instanceof HTMLImageElement ? base.currentSrc || base.src : "";
      if (!isTauri || !/^https?:/i.test(url)) return undefined;
      try {
        const data = await fetchImage(url, book.sourceUrl);
        const im = new Image();
        im.src = data;
        await im.decode();
        return await attempt(im, im.naturalWidth, im.naturalHeight);
      } catch {
        return undefined;
      }
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !doc) return;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      // PDF: a page (always for pages without text; otherwise with the tool or Alt). Other formats: a picture, straight away.
      let base: HTMLElement | null;
      if (isPdf) {
        base = t.closest<HTMLElement>(".pdf-page");
        if (!base || !(base.classList.contains("no-text") || e.altKey || regionToolRef.current)) return;
      } else {
        base = t.closest<HTMLElement>(PICTURE_SELECTOR);
        if (!base || !host.contains(base)) return;
      }
      e.preventDefault(); // no text selection / native picture drag starts
      window.getSelection()?.removeAllRanges();
      setSel(null);
      const target = base;
      // An SVG <image> (covers, plates) has no natural size of its own: load the same picture to measure and crop it.
      let probe: HTMLImageElement | null = null;
      if (!isPdf && !(target instanceof HTMLImageElement)) {
        const href = pictureHref(target);
        if (href) {
          probe = new Image();
          probe.src = href;
        }
      }
      const natOf = () =>
        target instanceof HTMLImageElement ? { w: target.naturalWidth, h: target.naturalHeight } : probe?.naturalWidth ? { w: probe.naturalWidth, h: probe.naturalHeight } : null;
      const rectOf = () => (isPdf ? target.getBoundingClientRect() : pictureRect(target, natOf()));
      // Work in client coordinates (corrected for scrolling while dragging) and convert with the picture's FINAL
      // rectangle, so a picture whose size is learned a moment later (SVG images) still gets exact fractions.
      const cx0 = e.clientX;
      const cy0 = e.clientY;
      const scroll0 = scrollerRef.current?.scrollTop ?? 0;
      let end: { x: number; y: number } | null = null;
      const relRect = (pr: { left: number; top: number; width: number; height: number }) => {
        const dy = (scrollerRef.current?.scrollTop ?? 0) - scroll0;
        const ex = end?.x ?? cx0;
        const ey = end?.y ?? cy0;
        const xl = clamp(Math.min(cx0, ex) - pr.left, 0, pr.width);
        const xr = clamp(Math.max(cx0, ex) - pr.left, 0, pr.width);
        const yt = clamp(Math.min(cy0 - dy, ey) - pr.top, 0, pr.height);
        const yb = clamp(Math.max(cy0 - dy, ey) - pr.top, 0, pr.height);
        return { x: xl, y: yt, w: xr - xl, h: yb - yt };
      };
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        end = { x: ev.clientX, y: ev.clientY };
        if (!moved && Math.abs(ev.clientX - cx0) + Math.abs(ev.clientY - cy0) < 8) return;
        moved = true;
        const pr = rectOf();
        const r = relRect(pr);
        const so = stageRef.current?.getBoundingClientRect();
        if (so) setDraft({ x: pr.left - so.left + r.x, y: pr.top - so.top + r.y, w: r.w, h: r.h });
      };
      const onUp = async () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (probe && !probe.naturalWidth) await probe.decode().catch(() => {}); // learn the picture's size before measuring
        const pr = rectOf();
        const r = relRect(pr);
        if (!moved || r.w < 14 || r.h < 14) return setDraft(null); // a plain click (selects an existing box instead)
        // The drag must not also count as a click on a link around the picture.
        window.addEventListener("click", (ev) => (ev.stopPropagation(), ev.preventDefault()), { capture: true, once: true });
        const so = stageRef.current?.getBoundingClientRect();
        const sc = scrollerRef.current;
        if (!so || !sc) return;
        const region = { x: r.x / pr.width, y: r.y / pr.height, w: r.w / pr.width, h: r.h / pr.height };
        const thumb = await cropThumb(probe?.naturalWidth ? probe : target, r, pr.width, pr.height);
        const frame = sampleFrame(probe?.naturalWidth ? probe : target, r, pr.width, pr.height);
        const top = Math.round(region.y * 10000);
        const sectionEl = isPdf ? target : target.closest<HTMLElement>("[data-section]");
        const section = isPdf ? Number(target.dataset.page) : Number(sectionEl?.dataset.section ?? 0);
        const image = !isPdf && sectionEl ? { index: pictureElements(sectionEl).indexOf(target), key: sizeKey(natOf()) } : undefined;
        // reflowing text: order by position in the section = the picture's order, then the box height
        const start = image ? image.index * 100000 + top : top;
        const anchor: TextAnchor = { section, start, end: start + 1, exact: "", prefix: "", suffix: "", region, ...(thumb ? { thumb } : {}), ...(frame ? { frame } : {}), ...(image ? { image } : {}) };
        const bx = pr.left - so.left + r.x;
        const by = pr.top - so.top + r.y;
        const half = Math.min(190, so.width / 2);
        const below = by - (sc.getBoundingClientRect().top - so.top) < 150;
        setSel({ anchor, x: Math.min(Math.max(bx + r.w / 2, half), so.width - half), y: below ? by + r.h + 10 : by - 10, below });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    host.addEventListener("mousedown", onDown, true);
    return () => host.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, isPdf]);

  // Region notes saved without a picture (the picture couldn't be read at the time) get one as soon as it can be made.
  const thumbTried = useRef(new Set<string>());
  useEffect(() => {
    const d = docRef.current;
    if (!d) return;
    for (const a of annotations) {
      const g = a.anchor.region;
      if (!g || (a.anchor.thumb && a.anchor.frame) || thumbTried.current.has(a.id) || !geo.boxes.has(a.id)) continue;
      thumbTried.current.add(a.id);
      void (async () => {
        const retryLater = () => void thumbTried.current.delete(a.id);
        let base: HTMLElement | null = null;
        let pw = 0;
        let ph = 0;
        if (a.anchor.image) {
          const el = findImage(d.sectionRoot(a.anchor.section), a.anchor.image);
          if (el instanceof HTMLImageElement) {
            if (!el.complete || !el.naturalWidth) return retryLater();
            const r = el.getBoundingClientRect();
            [base, pw, ph] = [el, r.width, r.height];
          } else if (el) {
            const href = pictureHref(el);
            if (!href) return;
            const probe = new Image();
            probe.src = href;
            try {
              await probe.decode();
            } catch {
              return;
            }
            [base, pw, ph] = [probe, probe.naturalWidth, probe.naturalHeight];
          }
        } else {
          const el = d.locate(a.anchor.section) as HTMLElement | null;
          if (!el?.querySelector("canvas.pdf-canvas")) return retryLater(); // the page isn't drawn yet
          const r = el.getBoundingClientRect();
          [base, pw, ph] = [el, r.width, r.height];
        }
        if (!base || !pw || !ph) return;
        const px = { x: g.x * pw, y: g.y * ph, w: g.w * pw, h: g.h * ph };
        const thumb = a.anchor.thumb ?? (await cropThumb(base, px, pw, ph));
        const frame = a.anchor.frame ?? sampleFrame(base, px, pw, ph);
        if (thumb !== a.anchor.thumb || frame !== a.anchor.frame) update(a.id, { anchor: { ...a.anchor, ...(thumb ? { thumb } : {}), ...(frame ? { frame } : {}) } });
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, annotations]);

  const createFromSelection = (color: string, style: HighlightStyle, withNote: boolean, note = "") => {
    if (!sel) return;
    createFromAnchor(sel.anchor, color, style, withNote, note);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };
  const createFromAnchor = (anchor: TextAnchor, color: string, style: HighlightStyle, withNote: boolean, note = "") => {
    const now = Date.now();
    const { whole, ...origin } = noteOrigin(book.id, docRef.current?.sectionRoot(anchor.section) ?? null, anchor);
    const a: Annotation = {
      id: uid(),
      anchor: whole || anchor.whole ? { ...anchor, whole: true } : anchor,
      color,
      style,
      note,
      tags: [],
      side: "right",
      ...origin,
      createdAt: now,
      updatedAt: now,
    };
    mutate((list) => [...list, a]);
    // A quick color-click stays lightweight; only "笔记" opens the editor.
    setActiveId(withNote ? a.id : null);
    setFocusNoteId(withNote ? a.id : null);
    if (color !== settings.lastColor || style !== settings.lastStyle) onSettings({ lastColor: color, lastStyle: style });
  };

  const onStageClick = (e: React.MouseEvent) => {
    // a verse number of a module's document (an empty element marked data-ref-click): tell the module where it is
    const marker = (e.target as Element).closest?.("[data-ref-click]");
    const refEl = marker?.closest<HTMLElement>("[data-ref]");
    if (marker && refEl?.dataset.ref) {
      const r = marker.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent("reader:ref-click", { detail: { docId: book.id, ref: refEl.dataset.ref, x: r.left, y: r.bottom } }));
      return;
    }
    if ((e.target as Element).closest(".note-card, .sel-toolbar, .marker, a")) return;
    if (sel?.anchor.region) setSel(null);
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;
    const r = stageRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = [...annotations].reverse().find((a) => {
      const b = geo.boxes.get(a.id);
      return b && hitTest(b, x, y);
    });
    setActiveId(hit ? hit.id : null);
    setFocusNoteId(null);
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && isPdf) {
        e.preventDefault();
        setJump("");
        return;
      }
      const typing = (e.target as Element).closest?.("textarea, input");
      if (e.key === "Escape") {
        // Writing a whole-document note: the first Esc only leaves the field, so typed text isn't lost.
        if (typing && (e.target as Element).closest?.(".doc-modal")) return;
        setPanel(null);
        setTocOpen(false);
        setSel(null);
        if (!typing) setActiveId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPdf]);

  // ---------- zoom (the window zoom itself is applied by App) ----------
  const zoomHint = useZoomControls(true, settings.zoom, (zoom) => onSettings({ zoom }));

  // ---------- derived layout ----------
  // Heights measured while a card is collapsed: side assignment uses these so that
  // expanding (activating) a card never makes other cards jump to the opposite margin.
  const stableHeights = useRef<Record<string, number>>({});
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  /** Bare highlights carry no extra information: only notes (or the card being edited) occupy the margin. */
  const hasCard = useCallback((a: Annotation) => a.note.trim() !== "" || a.id === activeId, [activeId]);

  /**
   * Dual mode: each card goes to the margin where it would be pushed down the least;
   * ties alternate by count, so the two margins stay visually balanced. User-pinned sides win.
   */
  const sideOf = useMemo(() => {
    const m = new Map<string, "left" | "right">();
    if (L.mode !== "dual") {
      annotations.forEach((a) => m.set(a.id, "right"));
      return m;
    }
    const items = annotations
      .filter((a) => hasCard(a) && geo.ys.has(a.id))
      .map((a) => ({ a, y: geo.ys.get(a.id)! - 6, h: stableHeights.current[a.id] ?? heights[a.id] ?? 64 }))
      .sort((p, q) => p.y - q.y || p.a.createdAt - q.a.createdAt);
    const bottom = { left: -Infinity, right: -Infinity };
    const count = { left: 0, right: 0 };
    for (const { a, y, h } of items) {
      let side: "left" | "right";
      if (a.sideLocked) side = a.side;
      else {
        const pushL = Math.max(0, bottom.left - y);
        const pushR = Math.max(0, bottom.right - y);
        side = pushL < pushR ? "left" : pushR < pushL ? "right" : count.left < count.right ? "left" : "right";
      }
      bottom[side] = Math.max(y, bottom[side]) + h + CARD_GAP;
      count[side]++;
      m.set(a.id, side);
    }
    return m;
  }, [annotations, geo, heights, L.mode, hasCard]);

  const positions = useMemo(() => {
    const left: CardInput[] = [];
    const right: CardInput[] = [];
    if (showMargins) {
      for (const a of annotations) {
        const y = geo.ys.get(a.id);
        if (y === undefined || !hasCard(a)) continue;
        const side = sideOf.get(a.id) ?? "right";
        (side === "left" ? left : right).push({ id: a.id, ideal: y - 6, height: heights[a.id] ?? 64 });
      }
      // The 整体笔记 card only appears once the book has such notes (write the first one from the top-bar button).
      if (annotations.some(isDocNote)) right.push({ id: DOC_CARD, ideal: 76, height: heights[DOC_CARD] ?? 72 });
    }
    return {
      left: layoutCards(left, CARD_GAP, activeId),
      right: layoutCards(right, CARD_GAP, activeId),
    };
  }, [annotations, geo, heights, activeId, showMargins, sideOf, hasCard]);

  const onHeight = useCallback((id: string, h: number) => {
    if (id !== activeRef.current) stableHeights.current[id] = h;
    setHeights((old) => (Math.abs((old[id] ?? 0) - h) < 1 ? old : { ...old, [id]: h }));
  }, []);

  const overlay = useMemo(
    () =>
      annotations.map((a) => {
        const b = geo.boxes.get(a.id);
        if (!b || a.anchor.region) return null; // a boxed area is only a dashed frame (own layer): no tint over the picture
        const sw = swatch(a.color);
        const fill = dark ? sw.dark : sw.light;
        const stroke = dark ? sw.dark : sw.ink;
        if (a.style === "none") {
          if (a.id !== activeId) return null;
          return (
            <g key={a.id} className="hl ghost">
              {shapesFor("highlight", b, fontPx).map((s, i) => (
                <path key={i} className="hl-fill" d={s.d} fill={fill} />
              ))}
            </g>
          );
        }
        return (
          <g key={a.id} className={`hl ${a.id === activeId ? "active" : ""}`}>
            {shapesFor(a.style, b, fontPx, contentX, geo.chars.get(a.id)).map((s, i) =>
              s.kind === "fill" ? (
                <path key={i} className="hl-fill" d={s.d} fill={fill} />
              ) : s.kind === "ink" ? (
                <path key={i} className="hl-stroke" d={s.d} fill={stroke} />
              ) : (
                <path
                  key={i}
                  className="hl-stroke"
                  d={s.d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={s.width}
                  strokeDasharray={s.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ),
            )}
          </g>
        );
      }),
    [annotations, geo, activeId, dark, fontPx, contentX],
  );

  /** Dashed frames of boxed areas: normal blending (the tint layer multiplies), pale contrasting line over a dark halo. */
  const regionFrames = annotations.map((a) => {
    const b = a.anchor.region ? geo.boxes.get(a.id) : undefined;
    if (!b || a.style === "none" && a.id !== activeId) return null;
    const d = regionPath(b[0]);
    const line = a.anchor.frame?.c ?? "hsl(38 55% 78%)";
    const halo = a.anchor.frame?.h ?? "rgba(0,0,0,0.35)";
    return (
      <g key={a.id} className={`region-frame ${a.id === activeId ? "active" : ""}`} fill="none" strokeLinejoin="round">
        <path d={d} stroke={halo} strokeWidth={a.id === activeId ? 3 : 2.6} />
        <path d={d} stroke={line} strokeWidth={a.id === activeId ? 1.5 : 1.1} />
      </g>
    );
  });

  /** Every margin card is tied to its passage with the same curve + dot; the active one is just emphasised. */
  const connectors = (() => {
    if (!showMargins) return null;
    return annotations.map((a) => {
      const b = geo.boxes.get(a.id);
      const side = sideOf.get(a.id) ?? "right";
      const top = (side === "left" ? positions.left : positions.right).get(a.id);
      if (!b || top === undefined) return null;
      const y1 = b[0].y + b[0].h / 2;
      const y2 = top + 18;
      const x1 = side === "right" ? contentX + L.content + 6 : contentX - 6;
      const x2 = side === "right" ? rightX - 2 : L.margin + 2;
      const mx = (x1 + x2) / 2;
      const ink = dark ? swatch(a.color).dark : swatch(a.color).ink;
      return (
        <g key={a.id} className={`connector ${a.id === activeId ? "active" : ""}`} stroke={ink}>
          <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" />
          <circle cx={x1} cy={y1} r={2.2} fill={ink} stroke="none" />
        </g>
      );
    });
  })();

  const flatToc = useMemo(() => {
    const out: TocItem[] = [];
    const walk = (items: TocItem[]) => items.forEach((t) => (out.push(t), walk(t.children)));
    walk(doc?.toc ?? []);
    return out.filter((t) => t.section >= 0).sort((a, b) => a.section - b.section);
  }, [doc]);
  const chapterOf = useCallback(
    (section: number) => {
      let label = isPdf ? t("rd.page", { n: section + 1 }) : t("rd.body");
      for (const t of flatToc) if (t.section <= section) label = t.label;
      return label;
    },
    [flatToc, isPdf],
  );
  const currentChapter = chapterOf(currentSection);
  const pageCount = doc?.sectionCount() ?? 0;
  const pageText = t("rd.pageText", { n: currentSection + 1, total: pageCount || "?" });
  const subtitle = isPdf ? (flatToc.length ? `${currentChapter} · ${pageText}` : pageText) : currentChapter;
  /** "Go to page" box (Ctrl + G, or click the page number). */
  const [jump, setJump] = useState<string | null>(null);
  const submitJump = () => {
    const n = Math.round(Number(jump));
    if (jump && Number.isFinite(n) && n >= 1) goTo(Math.min(n, pageCount || n) - 1);
    setJump(null);
  };

  const exportMarkdown = async () => {
    if (!doc) return;
    const sorted = annotations.filter((a) => !isDocNote(a)).sort((a, b) => a.anchor.section - b.anchor.section || a.anchor.start - b.anchor.start);
    const lines = [`# ${shownTitle}`, ""];
    if (doc.author) lines.push(t("rd.author", { name: doc.author }), "");
    lines.push(`> ${t("export.header", { when: fmtDateTime(new Date()), n: annotations.length })}`, "");
    if (docNotes.length) {
      lines.push(`## ${t("export.docNotes")}`, "");
      for (const n of [...docNotes].sort((a, b) => a.createdAt - b.createdAt)) lines.push(n.note.trim(), ...(n.images?.length ? ["", ...imageEmbeds(n.images)] : []), "", `<sub>${new Date(n.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
    }
    let ch = "";
    for (const a of sorted) {
      const c = chapterOf(a.anchor.section);
      if (c !== ch) lines.push(`## ${(ch = c)}`, "");
      if (a.anchor.region) lines.push(...(a.anchor.thumb ? [...imageEmbeds([a.anchor.thumb]), ""] : []), a.anchor.image ? `> ${t("kind.imageRegion")}` : `> ${t("kind.pageRegion", { page: a.anchor.section + 1 })}`, "");
      else lines.push(`> ${a.anchor.exact.trim().replace(/\n+/g, "\n> ")}`, "");
      if (a.note.trim()) lines.push(a.note.trim(), "");
      if (a.images?.length) lines.push(...imageEmbeds(a.images), "");
      lines.push(`<sub>${swatch(a.color).name} · ${new Date(a.updatedAt).toLocaleDateString()}</sub>`, "", "---", "");
    }
    try {
      await exportTextFile(`${t("rd.fileSuffix", { title: shownTitle.replace(/[\\/:*?"<>|]/g, "_") })}.md`, lines.join("\n"), imageIdsOf(annotations.map((note) => ({ note }))));
    } catch (e) {
      onError(t("rd.exportFail", { err: String(e) }));
    }
  };

  const jumpTo = (a: Annotation) => {
    if (isDocNote(a)) {
      setPanel("doc");
      return;
    }
    const sc = scrollerRef.current;
    const stage = stageRef.current;
    const y = geo.ys.get(a.id);
    if (sc && stage && y !== undefined) {
      sc.scrollTop = stage.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + y - sc.clientHeight * 0.3;
    } else goTo(a.anchor.section);
    setActiveId(a.id);
    setPanel(null);
  };

  // ---------- whole-document notes ----------
  const docNotes = useMemo(() => annotations.filter(isDocNote), [annotations]);
  const noun = book.format === "md" || book.format === "html" ? t("noun.article") : t("noun.book");
  const addDocNote = (text: string) => {
    const now = Date.now();
    mutate((list) => [
      ...list,
      { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note: text, tags: parseTags(text), side: "right", kind: "doc", ...noteOrigin(book.id, null, null), createdAt: now, updatedAt: now },
    ]);
  };
  const removeDocNote = async (id: string) => {
    if (!(await confirmTrash(t("tr.confirmNote")))) return;
    mutate((list) => list.filter((x) => x.id !== id));
    reportDeleted();
  };

  const hits = useMemo<NoteHit[]>(() => annotations.map((note) => ({ bookId: book.id, note })), [annotations, book.id]);
  const bookMap = useMemo(() => new Map([[book.id, book]]), [book]);
  const filterByTag = (tag: string) => {
    setNotesFilter({ ...EMPTY_FILTER, sort: "position", tags: [tag] });
    setPanel("notes");
  };

  // Coming from the notes hub with a whole-document note: open the 整体笔记 panel.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || loading) return;
    const a = annotations.find((x) => x.id === id);
    if (a && isDocNote(a)) {
      pendingFocus.current = null;
      setPanel("doc");
    }
  }, [annotations, loading]);

  // Coming from the notes hub: once the note is laid out, bring it into view and open it.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !geo.ys.has(id)) return;
    const a = annotations.find((x) => x.id === id);
    pendingFocus.current = null;
    if (a) requestAnimationFrame(() => jumpTo(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);

  const active = annotations.find((a) => a.id === activeId) ?? null;
  const sheetOpen = !!active && (L.mode === "compact" || L.immersive);

  return (
    <div
      className={`reader theme-${settings.theme} mode-${L.immersive ? "immersive" : L.mode}`}
    >
      {zoomHint && <div className="zoom-hint">{Math.round(settings.zoom * 100)}%</div>}
      <SlotHost slot="reader.overlay" ctx={{ docId: book.id }} />
      {find && <FindPanel text={find.text} hits={find.hits} current={find.current} total={revealCount()} truncated={find.truncated} titleOf={sectionTitle} onPick={pickHit} onClose={() => (setFind(null), clearReveal())} />}
      {jump !== null && (
        <div className="jump-box" onMouseDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            inputMode="numeric"
            value={jump}
            placeholder={t("rd.jumpPlaceholder", { n: pageCount || "?" })}
            onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitJump();
              if (e.key === "Escape") (e.stopPropagation(), setJump(null));
            }}
            onBlur={() => setJump(null)}
          />
        </div>
      )}
      <header className="topbar">
        <button className="icon-btn" title={t("rd.back")} onClick={onClose}>
          <ChevronLeft size={20} />
        </button>
        <button
          className={`icon-btn ${tocOpen ? "on" : ""}`}
          title={t("rd.toc")}
          onClick={() => {
            setPanel(null);
            setTocOpen((v) => !v);
          }}
        >
          <List size={18} />
        </button>
        <div className="topbar-title">
          <span className="t">{shownTitle}</span>
          {isPdf ? (
            <button className="c page-jump" title={t("rd.jumpTip")} onClick={() => setJump("")}>
              {subtitle}
            </button>
          ) : (
            <span className="c">{subtitle}</span>
          )}
        </div>
        <div className="topbar-actions">
          <SlotHost slot="reader.topbar" ctx={{ docId: book.id }} />
          {book.sourceUrl && (
            <button className="icon-btn" title={t("rd.openOriginal", { url: book.sourceUrl })} onClick={() => openExternal(book.sourceUrl!)}>
              <ExternalLink size={17} />
            </button>
          )}
          {book.format !== "txt" && (
            <button
              className={`icon-btn ${regionTool ? "on" : ""}`}
              title={isPdf ? (regionTool ? t("rd.region.pdfOn") : t("rd.region.pdf")) : regionTool ? t("rd.region.docOn") : t("rd.region.doc")}
              onClick={() => setRegionTool((v) => !v)}
            >
              <BoxSelect size={18} />
            </button>
          )}
          <button className={`icon-btn ${panel === "doc" ? "on" : ""}`} title={t("doc.panelTip", { noun })} onClick={() => setPanel(panel === "doc" ? null : "doc")}>
            <StickyNote size={18} />
            {docNotes.length > 0 && <span className="badge">{docNotes.length}</span>}
          </button>
          <button className={`icon-btn ${panel === "notes" ? "on" : ""}`} title={t("rd.notes")} onClick={() => setPanel(panel === "notes" ? null : "notes")}>
            <NotebookPen size={18} />
            {annotations.length > 0 && <span className="badge">{annotations.length}</span>}
          </button>
          <button className={`icon-btn ${panel === "settings" ? "on" : ""}`} title={t("rd.settings")} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
            <Type size={18} />
          </button>
        </div>
      </header>

      {tocOpen && (
        <div className="toc-backdrop" onMouseDown={() => setTocOpen(false)}>
          <aside className="toc-sidebar" onMouseDown={(e) => e.stopPropagation()}>
            <div className="panel-title">
              <span>{t("rd.toc")}</span>
              <button className="icon-btn" title={t("rd.tocCollapse")} onClick={() => setTocOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <TocPanel
              toc={doc?.toc ?? []}
              current={currentSection}
              onGo={(t) => {
                setTocOpen(false);
                goTo(t.section, t.fragment);
              }}
            />
          </aside>
        </div>
      )}

      {panel && panel !== "doc" && (
        <div className="panel-backdrop" onMouseDown={() => setPanel(null)}>
          <div className="panel-wrap" onMouseDown={(e) => e.stopPropagation()}>
            {panel === "notes" && (
              <div className="panel notes-panel wide">
                <div className="panel-title">
                  <span>{t("rd.notesCount", { n: annotations.length })}</span>
                  <button className="panel-btn" onClick={exportMarkdown} disabled={!annotations.length} title={t("rd.exportMd")}>
                    <Download size={14} /> {t("rd.export")}
                  </button>
                </div>
                <NotesBrowser
                  compact
                  tagPicker
                  theme={settings.theme}
                  filter={notesFilter}
                  onFilter={setNotesFilter}
                  books={bookMap}
                  source={hits}
                  chapterOf={chapterOf}
                  onOpen={(h) => jumpTo(h.note)}
                  onEdit={(h, p) => update(h.note.id, p)}
                  onDelete={(h) => remove(h.note)}
                />
              </div>
            )}
            {panel === "settings" && <SettingsPanel s={settings} onChange={onSettings} isPdf={isPdf} canZoom={isTauri} stage={{ mode: L.immersive ? "immersive" : L.mode, width: avail, dual: minStageWidth("dual", doc?.preferredWidth ?? (isPdf ? 860 : 680), isPdf ? 16 : settings.fontSize), single: minStageWidth("single", doc?.preferredWidth ?? (isPdf ? 860 : 680), isPdf ? 16 : settings.fontSize) }} />}
          </div>
        </div>
      )}

      {panel === "doc" && (
        <div className="doc-modal-backdrop" onMouseDown={() => setPanel(null)}>
          <div className="doc-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="doc-modal-head">
              <div>
                <div className="doc-modal-kicker">{t("rd.docKicker")}</div>
                <h2>{shownTitle}</h2>
              </div>
              <span className="nb-spacer" />
              <ReadingMeta book={book} onChange={(p) => onBookUpdate(book.id, p)} />
              <button className="icon-btn" title={t("rd.closeEsc")} onClick={() => setPanel(null)}>
                <X size={20} />
              </button>
            </header>
            <div className="doc-modal-body">
              <ReadingStats bookId={book.id} progress={progress} enabled={settings.readingTrack !== false} />
              <DocNotes
                variant="panel"
                noun={noun}
                notes={docNotes}
                onAdd={addDocNote}
                onEdit={(id, note) => update(id, { note })}
                onDelete={removeDocNote}
                onShowAll={() => {
                  setNotesFilter({ ...EMPTY_FILTER, sort: "position", kind: "doc" });
                  setPanel("notes");
                }}
              />
            </div>
          </div>
        </div>
      )}

      <div className={`scroller ${regionTool ? "region-tool" : ""}`} ref={scrollerRef} onScroll={onScroll} onClick={onStageClick}>
        <div
          className={`stage ${isEn ? "lang-en" : ""}`}
          ref={stageRef}
          style={
            {
              width: stageW,
              "--font-body": bodyFont(settings),
              "--font-size": `${settings.fontSize}px`,
              "--line-height": settings.lineHeight,
              "--indent": settings.indent ? "2em" : "0",
            } as React.CSSProperties
          }
        >
          <article
            className={`content fmt-${book.format}`}
            ref={hostRef}
            style={{ width: L.content, marginLeft: contentX }}
            lang={isEn ? "en" : "zh-CN"}
          />

          <svg className="overlay" width={stageW} height={stageH} aria-hidden>
            {overlay}
            {connectors}
          </svg>
          <svg className="overlay frames" width={stageW} height={stageH} aria-hidden>
            {regionFrames}
            {draft && (
              <g className="region-draft" fill="none" strokeLinejoin="round">
                <rect x={draft.x} y={draft.y} width={draft.w} height={draft.h} rx={5} stroke="rgba(0,0,0,0.35)" strokeWidth={2.6} />
                <rect x={draft.x} y={draft.y} width={draft.w} height={draft.h} rx={5} stroke="#f3e3b8" strokeWidth={1.2} />
              </g>
            )}
          </svg>

          {showMargins && annotations.some(isDocNote) && (
            <div className="doc-card" style={{ top: Math.max(8, positions.right.get(DOC_CARD) ?? 76), left: rightX, width: L.margin }}>
              <DocNotes
                variant="card"
                noun={noun}
                notes={docNotes}
                onAdd={addDocNote}
                onEdit={(id, note) => update(id, { note })}
                onDelete={removeDocNote}
                onTag={filterByTag}
                onHeight={(h) => onHeight(DOC_CARD, h)}
              />
            </div>
          )}

          {showMargins &&
            annotations.map((a) => {
              if (isDocNote(a)) return null;
              const side = sideOf.get(a.id) ?? "right";
              const top = (side === "left" ? positions.left : positions.right).get(a.id);
              if (top === undefined) return null;
              return (
                <NoteCard
                  key={a.id}
                  a={a}
                  theme={settings.theme}
                  variant="margin"
                  side={side}
                  active={a.id === activeId}
                  autoFocus={a.id === focusNoteId}
                  canSwapSide={L.mode === "dual"}
                  onSwapSide={() => update(a.id, { side: side === "left" ? "right" : "left", sideLocked: true })}
                  style={{ top, left: side === "left" ? 0 : rightX, width: L.margin }}
                  onActivate={() => {
                    setActiveId(a.id);
                    setFocusNoteId(null);
                  }}
                  onChange={(p) => editFromCard(a.id, p)}
                  onDelete={() => remove(a)}
                  onHeight={(h) => onHeight(a.id, h)}
                  onTag={filterByTag}
                  onDone={() => setActiveId(null)}
                />
              );
            })}

          {showMarkers &&
            annotations.map((a) => {
              const y = geo.ys.get(a.id);
              if (y === undefined || !a.note.trim()) return null;
              const b = geo.boxes.get(a.id);
              const h = b ? Math.max(10, b[b.length - 1].y + b[b.length - 1].h - b[0].y) : 12;
              const sw = swatch(a.color);
              return (
                <button
                  key={a.id}
                  className={`marker ${a.note ? "has-note" : ""} ${a.id === activeId ? "on" : ""}`}
                  style={{ top: y, height: h, left: L.content + 7, ["--accent" as string]: dark ? sw.dark : sw.ink }}
                  title={a.note || a.anchor.exact}
                  onClick={() => setActiveId(a.id)}
                />
              );
            })}

          {sel && (
            <SelectionToolbar
              x={sel.x}
              y={sel.y}
              below={sel.below}
              theme={settings.theme}
              color={settings.lastColor}
              style={settings.lastStyle}
              onStyle={(s) => (s === settings.lastStyle ? onSettings({ lastStyle: "none" }) : createFromSelection(settings.lastColor, s, false))}
              onPick={(c) => createFromSelection(c, settings.lastStyle === "none" ? "highlight" : settings.lastStyle, false)}
              onNote={() => createFromSelection(settings.lastColor, settings.lastStyle, true)}
              onTodo={() => createFromSelection(settings.lastColor, settings.lastStyle === "none" ? "highlight" : settings.lastStyle, true, "- [ ] ")}
              hideCopy={!!sel.anchor.region}
              onCopy={() => {
                navigator.clipboard?.writeText(sel.anchor.exact).catch(() => {});
                window.getSelection()?.removeAllRanges();
                setSel(null);
              }}
            />
          )}
        </div>
        <div className="end-space" />
      </div>

      {sheetOpen && active && (
        <div className="sheet-backdrop" onMouseDown={() => setActiveId(null)}>
          <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <button className="sheet-close icon-btn" onClick={() => setActiveId(null)}>
              <X size={18} />
            </button>
            <NoteCard
              a={active}
              theme={settings.theme}
              variant="sheet"
              active
              autoFocus={active.id === focusNoteId}
              onActivate={() => {}}
              onChange={(p) => editFromCard(active.id, p)}
              onDelete={() => remove(active)}
              onDone={() => setActiveId(null)}
            />
          </div>
        </div>
      )}

      <div className="progress" style={{ ["--p" as string]: progress }}>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      {loading && <div className="loading">{t("rd.layouting")}</div>}
    </div>
  );
}
