import { isDarkTheme } from "../settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, BookOpen, CheckSquare, Target, FileText, FilePlus2, Maximize, Maximize2, Minimize, Minimize2, NotebookPen, PanelRightClose, PanelRightOpen, Plus, SlidersHorizontal, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import { confirmDialog, setWindowFullscreen } from "../platform";
import { isFreeNote, type BookRecord, type NoteLink } from "../core/types";
import { PALETTE, swatch } from "../core/palette";
import { notesStore, useNotesVersion, type NoteHit, type TagInfo } from "../notes/store";
import { isUnder, parseTags } from "../notes/tags";
import { CARD_H, CARD_W, DOT, SHAPES, anchorAt, dashOf, effectiveSides, geom, layout, LINK_STYLES, linksOf, makeLink, neighbourhood, notePreview, routeAll, type Pt, type Shape, type Size } from "../notes/links";
import { useLinks } from "../notes/useLinks";
import type { Theme } from "../settings";
import { NoteText } from "./NoteText";
import { NoteLinks } from "./NoteLinks";
import { LinkDialog, sourceName } from "./LinkDialog";
import { RelatedComposer } from "./RelatedComposer";
import { useTasks } from "../tasks/useTasks";
import { useGoals } from "../tasks/useGoals";
import { supportMap } from "../tasks/goals";
import { collate, t } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

const MAX_CARD = 700;
const LINE_H = 19; // px per text line in a card
const MAX_NODES = 300;
const NARROW = 700;

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: "node"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; cur?: Pt; adj: NoteLink[]; over?: string | null }
  | { kind: "resize"; id: string; edge: string; sx: number; sy: number; ow: number; oh: number; left: number; top: number; adj: NoteLink[]; cur?: { size: Size; center: Pt } }
  | { kind: "connect"; from: string }
  | { kind: "grip"; end: 0 | 1; card: string; start: string; side: string; moved: boolean; sx: number; sy: number };

type Editor = { mode: "new"; a: string; b: string } | { mode: "edit"; link: NoteLink };

const iconOf = (hit: NoteHit, books: Map<string, BookRecord>) => {
  if (isFreeNote(hit.note)) return <NotebookPen size={14} />;
  const f = books.get(hit.bookId)?.format;
  return f === "md" || f === "html" ? <FileText size={14} /> : <BookOpen size={14} />;
};

/**
 * The relation graph: notes are cards, links are lines carrying their description.
 * Drag a card to move it, drag from its orange dot onto another card to connect them, click a line to rename or
 * delete it. Selecting a card dims everything but its neighbours and opens its details with all its relations.
 */
export function NoteGraph({ books, theme, onOpenNote, notify, headerExtra }: { books: Map<string, BookRecord>; theme: Theme; onOpenNote(hit: NoteHit): void; notify(msg: string): void; headerExtra?: React.ReactNode }) {
  const version = useNotesVersion();
  const links = useLinks();
  const [hits, setHits] = useState<Map<string, NoteHit>>(new Map());
  const [onlyLinked, setOnlyLinked] = useState(true);
  const [showTasks, setShowTasks] = useState(false); // todos and goals as extra nodes around the notes
  const [noTodo, setNoTodo] = useState(false); // only notes that no todo was written in
  const allTasks = useTasks();
  const { goals, links: goalLinks } = useGoals();
  const todosOf = useMemo(() => {
    const m = new Map<string, typeof allTasks>();
    for (const t of allTasks) if (t.sourceNoteId) m.set(t.sourceNoteId, [...(m.get(t.sourceNoteId) ?? []), t]);
    return m;
  }, [allTasks]);
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [focusOn, setFocusOn] = useState(false);
  const [depth, setDepth] = useState(1);
  const [pos, setPos] = useState<Map<string, Pt>>(new Map());
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map()); // cards the user resized (the others have the default size)
  const dropId = useRef<string | null>(null); // the card a dragged line / card is currently over
  const [ready, setReady] = useState(false);
  // The viewport is kept in a ref and written straight to the DOM while panning / zooming, and cards, lines and
  // labels are moved by hand while one is dragged: re-rendering hundreds of elements per mouse move would be far too slow.
  // React catches up once the interaction is over.
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const world = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const bumpTimer = useRef(0);
  const setView = useCallback((f: View | ((v: View) => View)) => {
    const v = typeof f === "function" ? f(viewRef.current) : f;
    viewRef.current = v;
    if (world.current) world.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    window.clearTimeout(bumpTimer.current);
    bumpTimer.current = window.setTimeout(() => bump((n) => n + 1), 120);
  }, []);
  const view = viewRef.current;
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const lineEls = useRef(new Map<string, SVGPathElement>());
  const labelEls = useRef(new Map<string, HTMLElement>());
  const ghostEl = useRef<SVGLineElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState("");
  const [ghostFrom, setGhostFrom] = useState<string | null>(null); // a connection is being dragged from this card
  const [menu, setMenu] = useState<{ x: number; y: number; hit: NoteHit } | null>(null);
  const [linkFor, setLinkFor] = useState<NoteHit | null>(null);
  const [relatedFrom, setRelatedFrom] = useState<NoteHit[] | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const box = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const [outerW, setOuterW] = useState(0);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);
  const [full, setFull] = useState(false); // the graph covers the whole window (and the window itself goes full screen)
  const [panelHidden, setPanelHidden] = useState(false); // details panel folded away (full-screen mode)
  const refit = useRef(false);
  // how connecting lines are drawn (a personal preference, remembered)
  const [shape, setShape] = useState<Shape>(() => {
    try {
      const v = localStorage.getItem("reader:graph-shape");
      if (SHAPES.some((x) => x.key === v)) return v as Shape;
      return localStorage.getItem("reader:graph-curved") === "0" ? "straight" : "flow";
    } catch {
      return "flow";
    }
  });
  const chooseShape = (v: Shape) => {
    setShape(v);
    try {
      localStorage.setItem("reader:graph-shape", v);
    } catch {
      /* storage unavailable */
    }
  };
  const lastClick = useRef({ id: "", t: 0 });

  // ---- data
  useEffect(() => {
    let alive = true;
    (async () => {
      const linked = [...new Set(links.flatMap((l) => [l.a, l.b]))];
      const m = new Map((await notesStore.byIds(linked)).map((h) => [h.note.id, h]));
      if (!onlyLinked) (await notesStore.query({ limit: MAX_NODES })).items.forEach((h) => m.has(h.note.id) || m.set(h.note.id, h));
      if (alive) setHits(m);
    })();
    return () => {
      alive = false;
    };
  }, [links, onlyLinked, version]);
  useEffect(() => {
    notesStore.tags().then(setTags);
  }, [version]);
  useEffect(() => {
    notesStore.graphPos().then((list) => {
      setPos(new Map(list.map((p) => [p.noteId, { x: p.x, y: p.y }])));
      setSizes(new Map(list.filter((p) => (p.w ?? 0) > 0 && (p.h ?? 0) > 0).map((p) => [p.noteId, { w: p.w!, h: p.h! }])));
      setReady(true);
    });
  }, []);
  // `outer` is the whole view (decides list vs. graph), `box` the canvas itself (shrinks when the details panel docks).
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setOuterW(el.clientWidth));
    ro.observe(el);
    setOuterW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const narrow = outerW > 0 && outerW < NARROW;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [narrow, full]);

  // ---- full screen: F toggles, Esc leaves (unless a dialog / editor / menu is open and wants the Esc itself)
  const toggleFull = useCallback((on: boolean) => {
    refit.current = true; // fit the picture to the new canvas size once it has been measured
    setFull(on);
    void setWindowFullscreen(on);
  }, []);
  const busyRef = useRef(false);
  busyRef.current = !!(linkFor || relatedFrom || editor || menu);
  const dialogRef = useRef(false);
  dialogRef.current = !!(linkFor || relatedFrom);
  // the selected line (its editor is open): Delete removes it
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  const deleteSelectedLine = async () => {
    const ed = editorRef.current;
    if (ed?.mode !== "edit") return;
    setEditor(null);
    try {
      await notesStore.removeLink(ed.link.id);
      notify(t("graph.linkDeleted"));
    } catch (e) {
      notify(t("graph.deleteFail", { err: String(e) }));
    }
  };
  const deleteRef = useRef(deleteSelectedLine);
  deleteRef.current = deleteSelectedLine;
  // Delete pressed in the description field right after selecting a line (nothing typed yet) also means "delete the line"
  const edTouched = useRef(false);
  const editingId = editor?.mode === "edit" ? editor.link.id : null;
  useEffect(() => {
    edTouched.current = false;
  }, [editingId]);
  const fullRef = useRef(false);
  fullRef.current = full;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (editorRef.current?.mode === "edit" && !dialogRef.current) {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          void deleteRef.current();
          return;
        }
        if (e.key === "Escape") {
          setEditor(null);
          return;
        }
      }
      if (busyRef.current) return;
      if (e.key === "f" || e.key === "F") toggleFull(!fullRef.current);
      else if (e.key === "Escape" && fullRef.current) toggleFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (fullRef.current) void setWindowFullscreen(false); // never leave the window stuck in full screen
    };
  }, [toggleFull]);

  // ---- which notes are shown
  const ids = useMemo(() => {
    let list = [...hits.keys()];
    if (tag) list = list.filter((id) => parseTags(hits.get(id)!.note.note).some((t) => isUnder(t, tag)));
    if (noTodo) list = list.filter((id) => !todosOf.has(id));
    if (focusOn && sel && hits.has(sel)) {
      const near = neighbourhood(links, [sel], depth);
      list = list.filter((id) => near.has(id));
    }
    return list;
  }, [hits, tag, focusOn, sel, depth, links, noTodo, todosOf]);
  const idSet = useMemo(() => new Set(ids), [ids]);
  const shownLinks = useMemo(() => links.filter((l) => idSet.has(l.a) && idSet.has(l.b)), [links, idSet]);
  const idsKey = ids.join("\u0000");
  const sz = (id: string): Size => sizes.get(id) ?? { w: CARD_W, h: CARD_H };

  // New notes get a place by force layout; notes that already have a position stay where they are.
  useEffect(() => {
    if (!ready || !ids.length) return;
    if (ids.every((id) => pos.has(id))) return;
    const fixed = new Map([...pos].filter(([id]) => idSet.has(id)));
    setPos((old) => {
      const next = layout(ids, shownLinks, fixed, sizes);
      const merged = new Map(old);
      next.forEach((p, id) => merged.set(id, p));
      return merged;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, idsKey]);

  const overlayRef = useRef<{ nodes: { x: number; y: number }[] }>({ nodes: [] });
  const fit = useCallback(() => {
    const pts = ids.map((id) => pos.get(id)).filter((p): p is Pt => !!p);
    if (!pts.length || !size.w) return;
    const boxes = ids.filter((id) => pos.has(id)).map((id) => ({ p: pos.get(id)!, s: sz(id) }));
    for (const n of overlayRef.current.nodes) boxes.push({ p: { x: n.x, y: n.y }, s: { w: 130, h: 24 } }); // todos and goals, when shown
    const minX = Math.min(...boxes.map((b) => b.p.x - b.s.w / 2));
    const maxX = Math.max(...boxes.map((b) => b.p.x + b.s.w / 2));
    const minY = Math.min(...boxes.map((b) => b.p.y - b.s.h / 2));
    const maxY = Math.max(...boxes.map((b) => b.p.y + b.s.h / 2));
    const k = Math.max(0.2, Math.min((size.w - 80) / (maxX - minX), (size.h - 80) / (maxY - minY), 1.1));
    setView({ k, x: size.w / 2 - ((minX + maxX) / 2) * k, y: size.h / 2 - ((minY + maxY) / 2) * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, pos, size, sizes]);
  useEffect(() => {
    if (!refit.current || !size.w || !ids.length) return;
    refit.current = false;
    fit();
  }, [size.w, size.h, fit, ids.length]);
  useEffect(() => {
    if (fitted.current || !ready || !size.w || !ids.length || !ids.every((id) => pos.has(id))) return;
    fitted.current = true;
    fit();
  }, [ready, size, ids, pos, fit]);

  // The details panel docks beside the canvas, so a card that would end up outside the shrunken canvas is brought into view.
  useEffect(() => {
    if (!sel || !size.w) return;
    const p = pos.get(sel);
    if (!p) return;
    setView((v) => {
      const sx = p.x * v.k + v.x;
      const sy = p.y * v.k + v.y;
      const cs = sz(sel);
      const mx = (cs.w / 2) * v.k + 24; // the whole card, not just its centre, must be inside
      const my = (cs.h / 2) * v.k + 24;
      const dx = sx < mx ? mx - sx : sx > size.w - mx ? size.w - mx - sx : 0;
      const dy = sy < my ? my - sy : sy > size.h - my ? size.h - my - sy : 0;
      return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, size.w, size.h]);
  const selHit = sel ? hits.get(sel) : undefined;
  const focusSet = useMemo(() => (sel ? neighbourhood(links, [sel], 1) : null), [sel, links]);

  // ---- pointer handling (pan, move a card, drag a connection)
  const toGraph = (cx: number, cy: number): Pt => {
    const r = box.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  };
  // ---- todos and goals as read-only nodes: todos hang under the note they were written in, goals stand at the right edge
  const overlay = useMemo(() => {
    const nodes: { id: string; kind: "task" | "goal"; x: number; y: number; label: string; done: boolean; title: string }[] = [];
    const edges: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    if (!showTasks) return { nodes, edges };
    const at = new Map<string, Pt>();
    let maxX = -Infinity;
    let minY = Infinity;
    for (const id of ids) {
      const p = pos.get(id);
      if (!p) continue;
      const cs = sz(id);
      maxX = Math.max(maxX, p.x + cs.w / 2);
      minY = Math.min(minY, p.y - cs.h / 2);
      const list = [...(todosOf.get(id) ?? [])].sort((a, b) => Number(a.done) - Number(b.done));
      list.slice(0, 4).forEach((t, i) => {
        const x = p.x;
        const y = p.y + cs.h / 2 + 30 + i * 30;
        at.set(t.id, { x, y });
        nodes.push({ id: `t:${t.id}`, kind: "task", x, y, label: t.title, done: t.done, title: t.title });
        edges.push({ key: `n${t.id}`, x1: i === 0 ? p.x : x, y1: i === 0 ? p.y + cs.h / 2 : y - 30 + 12, x2: x, y2: y - 12 });
      });
      if (list.length > 4) nodes.push({ id: `m:${id}`, kind: "task", x: p.x, y: p.y + cs.h / 2 + 30 + 4 * 30, label: t("graph.moreTodos", { n: list.length - 4 }), done: false, title: t("graph.moreTodosTip") });
    }
    if (!isFinite(maxX)) return { nodes, edges };
    const sup = supportMap(goalLinks, allTasks);
    let gi = 0;
    for (const g of goals) {
      if (g.status !== "doing") continue;
      const shown = (sup.get(g.id) ?? []).filter((t) => at.has(t.id));
      if (!shown.length) continue;
      const x = maxX + 190;
      const y = minY + gi++ * 44;
      nodes.push({ id: `g:${g.id}`, kind: "goal", x, y, label: g.title, done: false, title: t(g.kind === "year" ? "graph.goalYear" : "graph.goalMonth", { title: g.title }) });
      shown.forEach((t) => edges.push({ key: `g${g.id}${t.id}`, x1: x - 65, y1: y, x2: at.get(t.id)!.x + 65, y2: at.get(t.id)!.y }));
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTasks, ids, pos, sizes, todosOf, goals, goalLinks, allTasks]);
  overlayRef.current = overlay;
  useEffect(() => {
    if (showTasks) fit(); // bring the todos and goals into view when they are switched on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTasks]);
  // how every line is drawn: its shape, and the bend that avoids other lines and cards where it can
  const routes = useMemo(() => routeAll(shownLinks, pos, shape, sizes), [shownLinks, pos, shape, sizes]);
  const colorOf = (l: NoteLink) => (l.color ? (isDarkTheme(theme) ? swatch(l.color).dark : swatch(l.color).ink) : undefined);
  /** The card (other than `except`) whose box contains this point of the graph, if any. */
  const cardAt = (pt: Pt, except: string): string | null => {
    for (const id of ids) {
      if (id === except) continue;
      const c = pos.get(id);
      if (!c) continue;
      const s = sz(id);
      if (Math.abs(pt.x - c.x) <= s.w / 2 && Math.abs(pt.y - c.y) <= s.h / 2) return id;
    }
    return null;
  };
  /** Highlights the card a line or another card is being dropped on, so the user sees what a release would connect. */
  const markDrop = (id: string | null) => {
    if (dropId.current === id) return;
    if (dropId.current) nodeEls.current.get(dropId.current)?.classList.remove("drop");
    dropId.current = id;
    if (id) nodeEls.current.get(id)?.classList.add("drop");
  };
  /** Moves / resizes a card by hand (no React render) and redraws the lines and labels attached to it. */
  const placeNode = (id: string, c: Pt, size: Size, adj: NoteLink[]) => {
    const el = nodeEls.current.get(id);
    if (el) {
      el.style.left = `${c.x - size.w / 2}px`;
      el.style.top = `${c.y - size.h / 2}px`;
      el.style.width = `${size.w}px`;
      el.style.height = `${size.h}px`;
    }
    for (const l of adj) {
      const otherId = l.a === id ? l.b : l.a;
      const other = pos.get(otherId);
      if (!other) continue;
      const param = routes.get(l.id)?.param ?? 0;
      const mine = size;
      const theirs = sz(otherId);
      const sa = l.sideA ?? "";
      const sb = l.sideB ?? "";
      const g = l.a === id ? geom(shape, c, other, param, mine, theirs, sa, sb) : geom(shape, other, c, param, theirs, mine, sa, sb);
      lineEls.current.get(l.id)?.setAttribute("d", g.d);
      const label = labelEls.current.get(l.id);
      if (label) {
        label.style.left = `${g.mid.x}px`;
        label.style.top = `${g.mid.y}px`;
      }
    }
  };
  const savePlace = (list: { id: string; p: Pt; s?: Size }[]) =>
    notesStore.putGraphPos(list.map(({ id, p, s }) => ({ noteId: id, x: p.x, y: p.y, w: s?.w ?? 0, h: s?.h ?? 0 }))).catch(() => {});
  const setCardSize = (id: string, size: Size | null) => {
    setSizes((m) => {
      const n = new Map(m);
      if (size) n.set(id, size);
      else n.delete(id);
      return n;
    });
    const p = pos.get(id);
    if (p) void savePlace([{ id, p, s: size ?? undefined }]);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    const t = e.target as HTMLElement;
    const handle = t.closest<HTMLElement>("[data-handle]");
    const rz = t.closest<HTMLElement>("[data-rz]");
    const node = t.closest<HTMLElement>("[data-node]");
    // Controls floating over the graph handle their own clicks (pointer capture would redirect them to the stage).
    if (t.closest(".graph-editor, .graph-panel, .graph-tools, .graph-label, .graph-menu, .graph-anchor:not(.grip)")) return;
    box.current!.setPointerCapture(e.pointerId);
    const grip = t.closest<HTMLElement>("[data-grip]");
    if (grip && editor?.mode === "edit") {
      drag.current = { kind: "grip", end: Number(grip.dataset.grip) as 0 | 1, card: grip.dataset.card!, start: grip.dataset.side!, side: grip.dataset.side!, moved: false, sx: e.clientX, sy: e.clientY };
      return;
    }
    if (handle) {
      const from = handle.dataset.handle!;
      drag.current = { kind: "connect", from };
      setGhostFrom(from);
    } else if (rz && node) {
      const id = node.dataset.node!;
      const p = pos.get(id)!;
      const s = sz(id);
      drag.current = { kind: "resize", id, edge: rz.dataset.rz!, sx: e.clientX, sy: e.clientY, ow: s.w, oh: s.h, left: p.x - s.w / 2, top: p.y - s.h / 2, adj: shownLinks.filter((l) => l.a === id || l.b === id) };
    } else if (node) {
      const id = node.dataset.node!;
      const p = pos.get(id)!;
      drag.current = { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false, adj: shownLinks.filter((l) => l.a === id || l.b === id) };
    } else {
      const v = viewRef.current;
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "grip") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.moved = true;
      const c = pos.get(d.card);
      if (!c || editor?.mode !== "edit") return;
      const pt = toGraph(e.clientX, e.clientY);
      const cs = sz(d.card);
      let best = d.side;
      let bestDist = Infinity;
      for (const sd of ["t", "r", "b", "l"] as const) {
        const at = anchorAt(c, cs, sd);
        const dist = Math.hypot(pt.x - at.x, pt.y - at.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = sd;
        }
      }
      d.side = best;
      // light up the dot that a release would pick, and preview the line leaving from there
      document.querySelectorAll(".graph-anchor.hot").forEach((el) => el.classList.remove("hot"));
      document.querySelector(`.graph-anchor[data-card="${d.card}"][data-side="${best}"]`)?.classList.add("hot");
      const l = editor.link;
      const pa = pos.get(l.a);
      const pb = pos.get(l.b);
      if (pa && pb) {
        const g = geom(shape, pa, pb, routes.get(l.id)?.param ?? 0, sz(l.a), sz(l.b), (d.end === 0 ? best : l.sideA ?? "") as never, (d.end === 1 ? best : l.sideB ?? "") as never);
        lineEls.current.get(l.id)?.setAttribute("d", g.d);
        const label = labelEls.current.get(l.id);
        if (label) {
          label.style.left = `${g.mid.x}px`;
          label.style.top = `${g.mid.y}px`;
        }
      }
    } else if (d.kind === "connect") {
      const p = toGraph(e.clientX, e.clientY);
      ghostEl.current?.setAttribute("x2", String(p.x));
      ghostEl.current?.setAttribute("y2", String(p.y));
      markDrop(cardAt(p, d.from));
    } else if (d.kind === "resize") {
      const k = viewRef.current.k;
      const dx = (e.clientX - d.sx) / k;
      const dy = (e.clientY - d.sy) / k;
      const w = Math.min(MAX_CARD, Math.max(DOT, d.ow + (d.edge.includes("e") ? dx : 0)));
      const h = Math.min(MAX_CARD, Math.max(DOT, d.oh + (d.edge.includes("s") ? dy : 0)));
      // the top-left corner stays where it is; the opposite edges follow the pointer
      const center = { x: d.left + w / 2, y: d.top + h / 2 };
      d.cur = { size: { w, h }, center };
      placeNode(d.id, center, { w, h }, d.adj);
      const el = nodeEls.current.get(d.id);
      if (el) {
        el.classList.toggle("dot", w <= DOT + 6 && h <= DOT + 6);
        el.classList.toggle("compact", w < 120);
        const t = el.querySelector<HTMLElement>(".graph-text");
        if (t) t.style.webkitLineClamp = String(Math.max(1, Math.floor((h - 16) / LINE_H)));
      }
    } else if (d.kind === "node") {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      const k = viewRef.current.k;
      const p = { x: d.ox + dx / k, y: d.oy + dy / k };
      d.cur = p;
      placeNode(d.id, p, sz(d.id), d.adj);
      // dragging a card over another one means "connect these two": the other card lights up
      d.over = cardAt(toGraph(e.clientX, e.clientY), d.id);
      markDrop(d.over);
    } else {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.hypot(dx, dy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "grip") {
      document.querySelectorAll(".graph-anchor.hot").forEach((el) => el.classList.remove("hot"));
      if (editor?.mode === "edit") {
        const cur = ((d.end === 0 ? editor.link.sideA : editor.link.sideB) ?? "") as string;
        // dragged: the end goes to the chosen side; just clicked: pin it where it is, or release the pin
        const next = d.moved ? d.side : cur ? "" : d.start;
        void restyle(d.end === 0 ? { sideA: next as never } : { sideB: next as never });
      }
    } else if (d.kind === "connect") {
      setGhostFrom(null);
      const target = cardAt(toGraph(e.clientX, e.clientY), d.from);
      markDrop(null);
      if (target) {
        setDraft("");
        setEditor({ mode: "new", a: d.from, b: target });
      }
    } else if (d.kind === "resize") {
      if (d.cur) {
        const { size, center } = d.cur;
        setPos((m) => new Map(m).set(d.id, center));
        setSizes((m) => new Map(m).set(d.id, size));
        void savePlace([{ id: d.id, p: center, s: size }]);
      }
    } else if (d.kind === "node") {
      if (d.moved && d.over) {
        // released on top of another card: not a move but a request to relate the two; the card goes back where it was
        markDrop(null);
        placeNode(d.id, { x: d.ox, y: d.oy }, sz(d.id), d.adj);
        setDraft("");
        setEditor({ mode: "new", a: d.id, b: d.over });
      } else if (d.moved) {
        markDrop(null);
        const p = d.cur ?? pos.get(d.id);
        if (p) {
          setPos((m) => new Map(m).set(d.id, p));
          void savePlace([{ id: d.id, p, s: sizes.get(d.id) }]);
        }
      } else {
        // a second click on the same card within 400 ms = double-click (the browser's dblclick is lost to pointer capture)
        const now = Date.now();
        const h = hits.get(d.id);
        if (h && lastClick.current.id === d.id && now - lastClick.current.t < 400) {
          lastClick.current = { id: "", t: 0 };
          if (isFreeNote(h.note)) setSel(d.id);
          else onOpenNote(h);
        } else {
          lastClick.current = { id: d.id, t: now };
          setSel(d.id);
        }
      }
    } else if (!d.moved) {
      setSel(null);
      setEditor(null);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    setView((v) => {
      const k = Math.max(0.15, Math.min(2.5, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  };
  const zoomBy = (f: number) =>
    setView((v) => {
      const k = Math.max(0.15, Math.min(2.5, v.k * f));
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });

  const commitEditor = async () => {
    if (!editor) return;
    try {
      if (editor.mode === "new") await notesStore.putLinks([makeLink(editor.a, editor.b, draft)]);
      else if (draft.trim() !== editor.link.label) await notesStore.putLinks([{ ...editor.link, label: draft, updatedAt: Date.now() }]);
    } catch (e) {
      notify(t("graph.saveFail", { err: String(e) }));
    }
    setEditor(null);
  };
  const mid = (a: string, b: string): Pt | null => {
    const p = pos.get(a);
    const q = pos.get(b);
    return p && q ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : null;
  };

  const tagOptions = useMemo(() => tags.map((t) => t.tag).sort(collate), [tags]);
  const selLinks = sel ? linksOf(links, sel) : [];

  // ---- narrow windows: a plain list of the notes that have relations (a graph needs room)
  if (narrow) {
    const withLinks = ids.filter((id) => links.some((l) => l.a === id || l.b === id));
    return (
      <div className="graph graph-list" ref={outer}>
        <div className="graph-bar">
          {headerExtra}
          <span className="graph-count">{t("graph.listCount", { n: shownLinks.length })}</span>
        </div>
        <div className="graph-listbody">
          {!withLinks.length && <div className="graph-empty">{t("graph.listEmpty")}</div>}
          {withLinks.map((id) => {
            const h = hits.get(id)!;
            return (
              <div key={id} className="graph-list-item">
                <div className="graph-list-title">
                  {iconOf(h, books)} {notePreview(h.note, 70)}
                </div>
                <NoteLinks noteId={id} links={linksOf(links, id)} books={books} onOpenNote={(o) => setSel(o.note.id)} onAdd={() => setLinkFor(h)} onRelated={() => setRelatedFrom([h])} notify={notify} />
              </div>
            );
          })}
        </div>
        {linkFor && <LinkDialog from={linkFor} books={books} onClose={() => setLinkFor(null)} notify={notify} />}
        {relatedFrom && <RelatedComposer sources={relatedFrom} books={books} onClose={() => setRelatedFrom(null)} notify={notify} />}
      </div>
    );
  }

  const edgeAt = (l: NoteLink): Pt | null => routes.get(l.id)?.geo.mid ?? null;
  // lay everything out again from scratch (fewest crossings), replacing the positions placed by hand
  const tidy = async () => {
    if (!(await confirmDialog(t("graph.tidyConfirm")))) return;
    const next = layout(ids, shownLinks, new Map(), sizes);
    setPos((m) => {
      const n = new Map(m);
      next.forEach((pt, id) => n.set(id, pt));
      return n;
    });
    refit.current = true;
    void savePlace(ids.map((id) => ({ id, p: next.get(id)!, s: sizes.get(id) })));
  };
  // The editor of a line sits below the two cards it joins (not on them), so their anchor dots stay visible and reachable.
  const ed = (() => {
    if (!editor) return null;
    if (editor.mode === "new") return mid(editor.a, editor.b);
    const m = edgeAt(editor.link);
    const pa = pos.get(editor.link.a);
    const pb = pos.get(editor.link.b);
    if (!m || !pa || !pb) return m;
    return { x: m.x, y: Math.max(pa.y + sz(editor.link.a).h / 2, pb.y + sz(editor.link.b).h / 2) + 26 };
  })();
  const restyle = async (patch: Partial<NoteLink>) => {
    if (!editor || editor.mode !== "edit") return;
    const next = { ...editor.link, ...patch, updatedAt: Date.now() };
    setEditor({ mode: "edit", link: next });
    try {
      await notesStore.putLinks([next]);
    } catch (e) {
      notify(t("graph.saveFail", { err: String(e) }));
    }
  };

  const body = (
    <div className={`graph ${full ? "full" : ""}`} ref={outer}>
      <div className="graph-bar">
        {!full && headerExtra}
        <select className="graph-select" value={tag} onChange={(e) => setTag(e.target.value)} title={t("graph.tagFilterTip")}>
          <option value="">{t("graph.allTags")}</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        <label className="graph-check">
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} /> {t("graph.onlyLinked")}
        </label>
        <label className="graph-check" title={t("graph.showTasksTip")}>
          <input type="checkbox" checked={showTasks} onChange={(e) => setShowTasks(e.target.checked)} /> {t("graph.showTasks")}
        </label>
        <label className="graph-check" title={t("graph.noTodoTip")}>
          <input type="checkbox" checked={noTodo} onChange={(e) => setNoTodo(e.target.checked)} /> {t("graph.noTodo")}
        </label>
        <label className={`graph-check ${sel ? "" : "off"}`} title={sel ? "" : t("graph.pickFirst")}>
          <input type="checkbox" checked={focusOn && !!sel} disabled={!sel} onChange={(e) => setFocusOn(e.target.checked)} /> {t("graph.neighbours")}
        </label>
        {focusOn && sel && (
          <select className="graph-select" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            <option value={1}>{t("graph.degree1")}</option>
            <option value={2}>{t("graph.degree2")}</option>
            <option value={3}>{t("graph.degree3")}</option>
          </select>
        )}
        <span className="nb-spacer" />
        <span className="graph-count">
          {t("graph.count", { notes: ids.length, links: shownLinks.length })}
        </span>
        <select className="graph-select" value={shape} onChange={(e) => chooseShape(e.target.value as Shape)} title={t("graph.shapeTip")}>
          {SHAPES.map((x) => (
            <option key={x.key} value={x.key}>
              {t("graph.shape", { name: x.name })}
            </option>
          ))}
        </select>
        <button className="graph-fs" title={t("graph.tidyTip")} onClick={tidy}>
          {t("graph.tidy")}
        </button>
        <button className="graph-fs" title={full ? t("graph.exitFullTip") : t("graph.fullTip")} onClick={() => toggleFull(!full)}>
          {full ? <Minimize size={15} /> : <Maximize size={15} />}
          {full ? t("graph.exitFull") : t("graph.full")}
        </button>
      </div>
      <div className="graph-main">
      <div className="graph-stage" ref={box} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}>
        {!ids.length && (
          <div className="graph-empty">
            {ready ? (links.length || !onlyLinked ? t("graph.noMatch") : t("graph.noLinks")) : ""}
          </div>
        )}
        <div className="graph-world" ref={world} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="graph-lines" width="1" height="1">
            {shownLinks.map((l) => {
              const p = pos.get(l.a);
              const q = pos.get(l.b);
              if (!p || !q) return null;
              const hot = !!sel && (l.a === sel || l.b === sel);
              const c = colorOf(l);
              return (
                <path
                  key={l.id}
                  ref={(el) => void (el ? lineEls.current.set(l.id, el) : lineEls.current.delete(l.id))}
                  d={routes.get(l.id)?.geo.d ?? ""}
                  data-ends={`${l.a}|${l.b}`}
                  className={`graph-line ${hot ? "hot" : ""} ${sel && !hot ? "dim" : ""}`}
                  style={{ stroke: c, strokeDasharray: dashOf(l.style) || undefined }}
                />
              );
            })}
            {overlay.edges.map((e) => (
              <line key={e.key} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} className="graph-line todo" />
            ))}
            {ghostFrom && pos.get(ghostFrom) && <line ref={ghostEl} x1={pos.get(ghostFrom)!.x} y1={pos.get(ghostFrom)!.y} x2={pos.get(ghostFrom)!.x} y2={pos.get(ghostFrom)!.y} className="graph-line ghost" />}
          </svg>
          {shownLinks.map((l) => {
            const m = edgeAt(l);
            if (!m) return null;
            const hot = !!sel && (l.a === sel || l.b === sel);
            const c = colorOf(l);
            return (
              <button
                key={l.id}
                ref={(el) => void (el ? labelEls.current.set(l.id, el) : labelEls.current.delete(l.id))}
                className={`graph-label ${hot ? "hot" : ""} ${sel && !hot ? "dim" : ""} ${l.label ? "" : "empty"}`}
                data-colored={c ? "" : undefined}
                style={{ left: m.x, top: m.y, ...(c ? { ["--lc" as string]: c } : {}) }}
                title={t("graph.editLabel")}
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft(l.label);
                  setEditor({ mode: "edit", link: l });
                }}
              >
                {l.label || "·"}
              </button>
            );
          })}
          {ids.map((id) => {
            const h = hits.get(id)!;
            const p = pos.get(id);
            if (!p) return null;
            const sw = swatch(h.note.color);
            const dim = !!focusSet && !focusSet.has(id);
            const cs = sz(id);
            const isDot = cs.w <= DOT + 6 && cs.h <= DOT + 6;
            const lines = Math.max(1, Math.floor((cs.h - 16) / LINE_H));
            return (
              <div
                key={id}
                ref={(el) => void (el ? nodeEls.current.set(id, el) : nodeEls.current.delete(id))}
                data-node={id}
                className={`graph-node ${sel === id ? "sel" : ""} ${dim ? "dim" : ""} ${isFreeNote(h.note) ? "free" : ""} ${isDot ? "dot" : ""} ${cs.w < 120 ? "compact" : ""}`}
                style={{ left: p.x - cs.w / 2, top: p.y - cs.h / 2, width: cs.w, height: cs.h, ["--accent" as string]: isDarkTheme(theme) ? sw.dark : sw.ink }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const r = box.current!.getBoundingClientRect();
                  setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, hit: h });
                }}
                title={`${notePreview(h.note, 200)}\n${sourceName(h, books)}`}
              >
                <span className="graph-ico">{iconOf(h, books)}</span>
                <span className="graph-text" style={{ WebkitLineClamp: lines }}>
                  {notePreview(h.note, 400)}
                </span>
                {!isDot && <span className="graph-handle" data-handle={id} title={t("graph.handleTip")} />}
                {!isDot && <span className="graph-rz e" data-rz="e" title={t("graph.resizeW")} />}
                {!isDot && <span className="graph-rz s" data-rz="s" title={t("graph.resizeH")} />}
                <span className="graph-rz se" data-rz="se" title={t("graph.resize")} />
              </div>
            );
          })}
          {overlay.nodes.map((n) => (
            <div key={n.id} className={`graph-extra ${n.kind} ${n.done ? "done" : ""}`} style={{ left: n.x - 65, top: n.y - 12 }} title={n.title}>
              {n.kind === "goal" ? <Target size={12} /> : <CheckSquare size={12} />}
              <span>{n.label}</span>
            </div>
          ))}
          {editor?.mode === "edit" &&
            [editor.link.a, editor.link.b].map((id, k) => {
              const c = pos.get(id);
              if (!c) return null;
              const cur = (k === 0 ? editor.link.sideA : editor.link.sideB) ?? "";
              const pa = pos.get(editor.link.a);
              const pb = pos.get(editor.link.b);
              const eff = pa && pb ? effectiveSides(shape, pa, pb, sz(editor.link.a), sz(editor.link.b), editor.link.sideA ?? "", editor.link.sideB ?? "")[k] : "";
              return (["t", "r", "b", "l"] as const).map((sd) => {
                const at = anchorAt(c, sz(id), sd);
                const grip = sd === eff; // the dot this end of the line really uses: drag it to another dot to move the end
                return (
                  <button
                    key={`${id}${sd}`}
                    className={`graph-anchor ${cur === sd ? "on" : ""} ${grip ? "grip" : ""}`}
                    style={{ left: at.x, top: at.y }}
                    data-card={id}
                    data-side={sd}
                    data-grip={grip ? String(k) : undefined}
                    title={grip ? t("graph.gripTip", { action: cur ? t("graph.gripAuto") : t("graph.gripPin") }) : t("graph.sideTip", { side: t(`graph.side.${sd}` as Key) })}
                    onClick={grip ? undefined : () => void restyle(k === 0 ? { sideA: sd } : { sideB: sd })}
                  />
                );
              });
            })}
          {editor && ed && (
            <div className={`graph-editor ${editor.mode === "edit" ? "wide" : ""}`} style={{ left: ed.x, top: ed.y, transform: `translate(-50%, ${editor.mode === "edit" ? "0" : "-50%"}) scale(${1 / view.k})`, transformOrigin: editor.mode === "edit" ? "50% 0" : undefined }}>
              <input
                autoFocus
                value={draft}
                placeholder={editor.mode === "new" ? t("graph.relPlaceholderNew") : t("graph.relPlaceholder")}
                onChange={(e) => setDraft(e.target.value)}
                onMouseDown={() => (edTouched.current = true)}
                onKeyDown={(e) => {
                  if (editor.mode === "edit" && e.key === "Delete" && !e.repeat && !edTouched.current) {
                    e.preventDefault();
                    void deleteSelectedLine();
                    return;
                  }
                  if (!["Delete", "Escape", "Enter", "Tab", "Shift", "Control", "Alt", "Meta"].includes(e.key)) edTouched.current = true;
                  if (e.key === "Enter") commitEditor();
                  if (e.key === "Escape") setEditor(null);
                }}
              />
              <button className="graph-ed-ok" onClick={commitEditor}>
                {t("graph.ok")}
              </button>
              {editor.mode === "edit" && (
                <button
                  className="graph-ed-del"
                  title={t("graph.deleteLinkTip")}
                  onClick={async () => {
                    await notesStore.removeLink(editor.link.id);
                    setEditor(null);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
              <button className="graph-ed-x" title={t("graph.cancel")} onClick={() => setEditor(null)}>
                <X size={14} />
              </button>
              {editor.mode === "edit" && (
                <div className="graph-ed-style">
                  <span className="graph-ed-cap">{t("graph.colour")}</span>
                  <button className={`graph-dot none ${!editor.link.color ? "on" : ""}`} title={t("graph.colourDefault")} onClick={() => restyle({ color: "" })} />
                  {PALETTE.map((p) => (
                    <button
                      key={p.key}
                      title={p.name}
                      className={`graph-dot ${editor.link.color === p.key ? "on" : ""}`}
                      style={{ background: isDarkTheme(theme) ? p.dark : p.ink }}
                      onClick={() => restyle({ color: p.key })}
                    />
                  ))}
                  <span className="graph-ed-cap sep">{t("graph.lineType")}</span>
                  {LINK_STYLES.map((st) => (
                    <button key={st.key} className={`graph-ls ${(editor.link.style || "solid") === st.key ? "on" : ""}`} title={st.name} onClick={() => restyle({ style: st.key === "solid" ? "" : st.key })}>
                      <svg width="34" height="8" aria-hidden="true">
                        <line x1="2" y1="4" x2="32" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={st.dash || undefined} />
                      </svg>
                    </button>
                  ))}
                </div>
              )}
              {editor.mode === "edit" && (
                <div className="graph-ed-sides">
                  <span>{t("graph.sidesHint")}</span>
                  {(editor.link.sideA || editor.link.sideB) && (
                    <button onClick={() => void restyle({ sideA: "", sideB: "" })}>{t("graph.allAuto")}</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="graph-tools">
          <button title={t("graph.zoomIn")} onClick={() => zoomBy(1.25)}>
            <ZoomIn size={16} />
          </button>
          <button title={t("graph.zoomOut")} onClick={() => zoomBy(1 / 1.25)}>
            <ZoomOut size={16} />
          </button>
          <button title={t("graph.fit")} onClick={fit}>
            <Maximize2 size={15} />
          </button>
        </div>
        <div className="graph-hint">{t("graph.hint")}</div>

        {menu && (
          <div className="graph-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
            <button
              onClick={() => {
                setRelatedFrom([menu.hit]);
                setMenu(null);
              }}
            >
              <FilePlus2 size={14} /> {t("graph.ctx.related")}
            </button>
            <button
              onClick={() => {
                setLinkFor(menu.hit);
                setMenu(null);
              }}
            >
              <Plus size={14} /> {t("graph.ctx.link")}
            </button>
            {!isFreeNote(menu.hit.note) && (
              <button
                onClick={() => {
                  onOpenNote(menu.hit);
                  setMenu(null);
                }}
              >
                <ArrowUpRight size={14} /> {t("graph.ctx.goText")}
              </button>
            )}
            <button
              onClick={() => {
                setSel(menu.hit.note.id);
                setFocusOn(true);
                setMenu(null);
              }}
            >
              <SlidersHorizontal size={14} /> {t("graph.ctx.neighbours")}
            </button>
            <button
              onClick={() => {
                setCardSize(menu.hit.note.id, { w: DOT, h: DOT });
                setMenu(null);
              }}
            >
              <Minimize2 size={14} /> {t("graph.ctx.dot")}
            </button>
            {sizes.has(menu.hit.note.id) && (
              <button
                onClick={() => {
                  setCardSize(menu.hit.note.id, null);
                  setMenu(null);
                }}
              >
                <Maximize2 size={14} /> {t("graph.ctx.restore")}
              </button>
            )}
          </div>
        )}
      </div>
      {selHit && full && panelHidden && (
        <button className="graph-panel-toggle" title={t("graph.panel.expand")} onClick={() => setPanelHidden(false)}>
          <PanelRightOpen size={15} /> {t("graph.panel.title")}
        </button>
      )}
      {selHit && !(full && panelHidden) && (
        <div className="graph-panel">
          <div className="graph-panel-head">
            <span className="graph-ico">{iconOf(selHit, books)}</span>
            <span className="graph-panel-src">{sourceName(selHit, books) || t("rc.note")}</span>
            <span className="nb-spacer" />
            {full && (
              <button title={t("graph.panel.collapse")} onClick={() => setPanelHidden(true)}>
                <PanelRightClose size={15} />
              </button>
            )}
            {!isFreeNote(selHit.note) && (
              <button title={t("nb.goText")} onClick={() => onOpenNote(selHit)}>
                <ArrowUpRight size={15} />
              </button>
            )}
            <button title={t("common.close")} onClick={() => setSel(null)}>
              <X size={15} />
            </button>
          </div>
          {selHit.note.anchor.exact && !selHit.note.anchor.region && <div className="graph-panel-quote">{selHit.note.anchor.exact}</div>}
          {selHit.note.note.trim() ? <NoteText className="nb-note" text={selHit.note.note} /> : <div className="graph-panel-none">{t("graph.panel.noText")}</div>}
          <NoteLinks
            noteId={selHit.note.id}
            links={selLinks}
            books={books}
            onOpenNote={(o) => {
              setSel(o.note.id);
              const p = pos.get(o.note.id);
              if (p) setView((v) => ({ ...v, x: size.w / 2 - p.x * v.k, y: size.h / 2 - p.y * v.k }));
            }}
            onAdd={() => setLinkFor(selHit)}
            onRelated={() => setRelatedFrom([selHit])}
            notify={notify}
          />
        </div>
      )}
      </div>
      {linkFor && <LinkDialog from={linkFor} books={books} onClose={() => setLinkFor(null)} notify={notify} />}
      {relatedFrom && <RelatedComposer sources={relatedFrom} books={books} onClose={() => setRelatedFrom(null)} onDone={(a) => setSel(a.id)} notify={notify} />}
    </div>
  );
  // Full screen: lifted out to <body> so no ancestor's transform / overflow can confine it.
  return full ? createPortal(body, document.body) : body;
}
