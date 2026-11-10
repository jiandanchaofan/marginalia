import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Download, ExternalLink, List, NotebookPen, StickyNote, Type, X } from "lucide-react";
import { DOC_ANCHOR, isDocNote, type Annotation, type BookRecord, type HighlightStyle, type LoadedDoc, type TextAnchor, type TocItem } from "../core/types";
import { loadDocument } from "../core/formats";
import { describe, resolve } from "../core/anchor";
import { isMostlyLatin } from "../core/lang";
import { charBoxes, hitTest, lineBoxes, type Box } from "../core/rects";
import { shapesFor } from "../core/draw";
import { swatch } from "../core/palette";
import { computeStage, layoutCards, minStageWidth, type CardInput } from "../core/layout";
import { openExternal, readBook, confirmDialog, exportTextFile, isTauri } from "../platform";
import { useZoomControls } from "../useZoom";
import { imageEmbeds, imageIdsOf } from "../notes/query";
import { notesStore, type NoteHit } from "../notes/store";
import { parseTags } from "../notes/tags";
import { EMPTY_FILTER, NotesBrowser, type NotesFilter } from "./NotesBrowser";
import { bodyFont, type Settings } from "../settings";
import { NoteCard } from "./NoteCard";
import { DocNotes, ReadingMeta } from "./DocNotes";
import { SelectionToolbar } from "./SelectionToolbar";
import { SettingsPanel, TocPanel } from "./Panels";

interface Props {
  book: BookRecord;
  /** Open the book at this note (coming from the notes hub). */
  openAtNoteId?: string | null;
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

export function Reader({ book, openAtNoteId, settings, onSettings, onBookUpdate, onClose, onError }: Props) {
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
  const [panel, setPanel] = useState<"notes" | "doc" | "settings" | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [notesFilter, setNotesFilter] = useState<NotesFilter>({ ...EMPTY_FILTER, sort: "position" });
  const pendingFocus = useRef<string | null>(openAtNoteId ?? null);
  const [progress, setProgress] = useState(book.progress);
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
        const [bytes, anns] = await Promise.all([readBook(book.id, book.ext), notesStore.forBook(book.id)]);
        if (cancelled) return;
        setAnnotations(anns);
        loaded = await loadDocument(bytes, book.ext, book.fileName);
        if (cancelled) return loaded.destroy();
        setDoc(loaded);
        // A title the user typed in (origTitle is set) is never overwritten by the file's own title.
        const title = book.origTitle ? book.title : loaded.title;
        if (title !== book.title || loaded.author !== book.author) onBookUpdate(book.id, { title, author: loaded.author });
      } catch (e) {
        onError(`无法打开《${book.title}》：${e instanceof Error ? e.message : String(e)}`);
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
    const restore = focusNote && !isDocNote(focusNote) ? { section: focusNote.anchor.section, ratio: 0 } : book.location;
    let restored = !restore || doc.format === "pdf";
    doc
      .mount(hostRef.current, {
        width: contentWidthRef.current,
        onSectionReady: (i) => {
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
    const t = setTimeout(() => {
      dirty.current = false;
      notesStore.putBook(book.id, annotations).catch((e) => onError(`笔记保存失败：${e}`));
      onBookUpdate(book.id, { annotationCount: annotations.length });
    }, 400);
    return () => clearTimeout(t);
  }, [annotations, book.id, onBookUpdate, onError]);

  useEffect(
    () => () => {
      if (dirty.current) notesStore.putBook(book.id, annRef.current).catch(() => {});
      persistPosition();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
    if (a.note.trim() && !(await confirmDialog("删除这条笔记？原文中的标注也会一并移除。"))) return;
    mutate((list) => list.filter((x) => x.id !== a.id));
    setActiveId(null);
  };

  // ---------- selection ----------
  const checkSelection = useCallback(() => {
    const s = window.getSelection();
    const host = hostRef.current;
    const stage = stageRef.current;
    const sc = scrollerRef.current;
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

  const createFromSelection = (color: string, style: HighlightStyle, withNote: boolean) => {
    if (!sel) return;
    const now = Date.now();
    const a: Annotation = {
      id: uid(),
      anchor: sel.anchor,
      color,
      style,
      note: "",
      tags: [],
      side: "right",
      createdAt: now,
      updatedAt: now,
    };
    mutate((list) => [...list, a]);
    window.getSelection()?.removeAllRanges();
    setSel(null);
    // A quick color-click stays lightweight; only "笔记" opens the editor.
    setActiveId(withNote ? a.id : null);
    setFocusNoteId(withNote ? a.id : null);
    if (color !== settings.lastColor || style !== settings.lastStyle) onSettings({ lastColor: color, lastStyle: style });
  };

  const onStageClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest(".note-card, .sel-toolbar, .marker, a")) return;
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
        if (!b) return null;
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
      let label = isPdf ? `第 ${section + 1} 页` : "正文";
      for (const t of flatToc) if (t.section <= section) label = t.label;
      return label;
    },
    [flatToc, isPdf],
  );
  const currentChapter = chapterOf(currentSection);

  const exportMarkdown = async () => {
    if (!doc) return;
    const sorted = annotations.filter((a) => !isDocNote(a)).sort((a, b) => a.anchor.section - b.anchor.section || a.anchor.start - b.anchor.start);
    const lines = [`# ${shownTitle}`, ""];
    if (doc.author) lines.push(`作者：${doc.author}`, "");
    lines.push(`> 导出自「墨边」· ${new Date().toLocaleString()} · 共 ${annotations.length} 条笔记`, "");
    if (docNotes.length) {
      lines.push("## 整体笔记", "");
      for (const n of [...docNotes].sort((a, b) => a.createdAt - b.createdAt)) lines.push(n.note.trim(), ...(n.images?.length ? ["", ...imageEmbeds(n.images)] : []), "", `<sub>${new Date(n.createdAt).toLocaleDateString()}</sub>`, "", "---", "");
    }
    let ch = "";
    for (const a of sorted) {
      const c = chapterOf(a.anchor.section);
      if (c !== ch) lines.push(`## ${(ch = c)}`, "");
      lines.push(`> ${a.anchor.exact.trim().replace(/\n+/g, "\n> ")}`, "");
      if (a.note.trim()) lines.push(a.note.trim(), "");
      if (a.images?.length) lines.push(...imageEmbeds(a.images), "");
      lines.push(`<sub>${swatch(a.color).name} · ${new Date(a.updatedAt).toLocaleDateString()}</sub>`, "", "---", "");
    }
    try {
      await exportTextFile(`${shownTitle.replace(/[\\/:*?"<>|]/g, "_")} - 笔记.md`, lines.join("\n"), imageIdsOf(annotations.map((note) => ({ note }))));
    } catch (e) {
      onError(`导出失败：${e}`);
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
  const noun = book.format === "md" || book.format === "html" ? "整篇文章" : "整本书";
  const addDocNote = (text: string) => {
    const now = Date.now();
    mutate((list) => [
      ...list,
      { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note: text, tags: parseTags(text), side: "right", kind: "doc", createdAt: now, updatedAt: now },
    ]);
  };
  const removeDocNote = async (id: string) => {
    if (!(await confirmDialog("删除这条整体笔记？"))) return;
    mutate((list) => list.filter((x) => x.id !== id));
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
      <header className="topbar">
        <button className="icon-btn" title="返回书库" onClick={onClose}>
          <ChevronLeft size={20} />
        </button>
        <button
          className={`icon-btn ${tocOpen ? "on" : ""}`}
          title="目录"
          onClick={() => {
            setPanel(null);
            setTocOpen((v) => !v);
          }}
        >
          <List size={18} />
        </button>
        <div className="topbar-title">
          <span className="t">{shownTitle}</span>
          <span className="c">{currentChapter}</span>
        </div>
        <div className="topbar-actions">
          {book.sourceUrl && (
            <button className="icon-btn" title={`查看原网页：${book.sourceUrl}`} onClick={() => openExternal(book.sourceUrl!)}>
              <ExternalLink size={17} />
            </button>
          )}
          <button className={`icon-btn ${panel === "doc" ? "on" : ""}`} title={`${noun}的整体笔记、评分与阅读状态`} onClick={() => setPanel(panel === "doc" ? null : "doc")}>
            <StickyNote size={18} />
            {docNotes.length > 0 && <span className="badge">{docNotes.length}</span>}
          </button>
          <button className={`icon-btn ${panel === "notes" ? "on" : ""}`} title="本书笔记" onClick={() => setPanel(panel === "notes" ? null : "notes")}>
            <NotebookPen size={18} />
            {annotations.length > 0 && <span className="badge">{annotations.length}</span>}
          </button>
          <button className={`icon-btn ${panel === "settings" ? "on" : ""}`} title="阅读设置" onClick={() => setPanel(panel === "settings" ? null : "settings")}>
            <Type size={18} />
          </button>
        </div>
      </header>

      {tocOpen && (
        <div className="toc-backdrop" onMouseDown={() => setTocOpen(false)}>
          <aside className="toc-sidebar" onMouseDown={(e) => e.stopPropagation()}>
            <div className="panel-title">
              <span>目录</span>
              <button className="icon-btn" title="收起目录" onClick={() => setTocOpen(false)}>
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
                  <span>本书笔记 · {annotations.length}</span>
                  <button className="panel-btn" onClick={exportMarkdown} disabled={!annotations.length} title="导出为 Markdown">
                    <Download size={14} /> 导出
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
                <div className="doc-modal-kicker">整体笔记</div>
                <h2>{shownTitle}</h2>
              </div>
              <span className="nb-spacer" />
              <ReadingMeta book={book} onChange={(p) => onBookUpdate(book.id, p)} />
              <button className="icon-btn" title="关闭（Esc）" onClick={() => setPanel(null)}>
                <X size={20} />
              </button>
            </header>
            <div className="doc-modal-body">
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

      <div className="scroller" ref={scrollerRef} onScroll={onScroll} onClick={onStageClick}>
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
      {loading && <div className="loading">正在排版…</div>}
    </div>
  );
}
