import { normText } from "./normalize";

interface TextMap {
  /** The page text without any spaces (lower case): what words are looked up in, so line breaks and spacing never matter. */
  sq: string;
  /** For each character of `sq`: the text node and offset it came from. */
  from: { node: Text; offset: number }[];
}

function mapOf(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("[data-anchor-ignore]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const chars: string[] = [];
  const from: { node: Text; offset: number }[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const s = n.data;
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue;
      chars.push(s[i].toLowerCase());
      from.push({ node: n, offset: i });
    }
  }
  return { sq: chars.join(""), from };
}

const squeeze = (s: string) => s.replace(/\s+/g, "");

/** Every place `w` (no spaces) occurs, as the start in `sq`. */
function occurrences(m: TextMap, w: string): number[] {
  const out: number[] = [];
  if (!w) return out;
  for (let k = m.sq.indexOf(w); k >= 0; k = m.sq.indexOf(w, k + w.length)) out.push(k);
  return out;
}

const rangeOf = (m: TextMap, start: number, len: number): Range | null => {
  const a = m.from[start];
  const z = m.from[Math.min(m.from.length - 1, start + len - 1)];
  if (!a || !z) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(z.node, z.offset + 1);
  return r;
};

interface Mark {
  range: Range;
  root: HTMLElement;
  cur: boolean;
}

const MAX_MARKS = 1500;
let lastCount = 0;
/** How many places the last search boxed. */
export const revealCount = () => lastCount;

/**
 * Box every place the words occur in the document at once (the one you came for gets a pulsing, stronger box), and scroll to
 * that one unless it is already comfortably in view. Words are matched ignoring spaces, so the index (cleaned text) and the
 * page (which may break lines anywhere, as PDF text does) meet.
 * `roots` are the sections of the document (a section that is not drawn yet may be null), `at` the one the result came from,
 * `snippet` tells which occurrence in it. `scroll: false` only redraws the boxes (more pages have been drawn since).
 */
export function revealText(roots: (HTMLElement | null)[], at: number, term: string, snippet?: string, opts: { scroll?: boolean } = {}): boolean {
  const w = squeeze(normText(term)).toLowerCase();
  if (!w) return false;
  const around = snippet ? squeeze(normText(snippet).replace(/^…|…$/g, "")).toLowerCase() : "";
  const marks: Mark[] = [];
  let current: Mark | null = null;
  roots.forEach((root, s) => {
    if (!root || marks.length >= MAX_MARKS) return;
    const m = mapOf(root);
    const found = occurrences(m, w);
    if (!found.length) return;
    // in the section the result came from, the occurrence nearest the snippet is "the" one
    let pick = -1;
    if (s === at) {
      const near = around ? m.sq.indexOf(around) : -1;
      pick = near >= 0 ? found.findIndex((k) => k >= near) : 0;
      if (pick < 0) pick = 0;
    }
    found.forEach((k, i) => {
      const range = rangeOf(m, k, w.length);
      if (!range || marks.length >= MAX_MARKS) return;
      const mark = { range, root, cur: i === pick };
      marks.push(mark);
      if (mark.cur) current = mark;
    });
  });
  lastCount = marks.length;
  if (!marks.length) return false;
  const cur: Mark | undefined = current ?? marks.find((m) => m.cur);
  if (opts.scroll !== false && cur) {
    // already comfortably in view: leave the page where it is; otherwise bring the words to the middle
    const box = cur.range.getBoundingClientRect();
    if (!(box.top >= 70 && box.bottom <= window.innerHeight - 70)) (cur.range.startContainer.parentElement ?? cur.root).scrollIntoView({ block: "center" });
  }
  if (!cur) marks[0].cur = true;
  draw(marks);
  return true;
}

let stopCurrent: (() => void) | null = null;
/** Take the boxes away. */
export const clearReveal = () => stopCurrent?.();
/** Whether boxes are on the page now (they go when the reader clicks the page, presses Esc, or closes the search window). */
export const revealActive = () => !!stopCurrent;

/**
 * Boxes drawn over the page (the text and the notes' own marks are left alone), following the words while the page moves.
 * They stay until the reader clicks the page, presses Esc, closes the search window, or five minutes pass.
 */
function draw(marks: Mark[]) {
  // a redraw keeps its grace period: do not let the first click through to a layer that is only being refreshed
  const refreshing = !!stopCurrent;
  stopCurrent?.();
  const layer = document.createElement("div");
  layer.className = "find-layer";
  document.body.appendChild(layer);
  let raf = 0;
  let alive = true;
  const paint = () => {
    raf = 0;
    if (!alive) return;
    const boxes: { r: DOMRect; cur: boolean }[] = [];
    const H = window.innerHeight;
    const near = new Map<HTMLElement, boolean>();
    for (const m of marks) {
      let on = near.get(m.root);
      if (on === undefined) {
        const rr = m.root.getBoundingClientRect();
        on = rr.bottom > -300 && rr.top < H + 300;
        near.set(m.root, on);
      }
      if (!on) continue;
      for (const r of m.range.getClientRects()) if (r.width > 1 && r.height > 1 && r.bottom > -20 && r.top < H + 20) boxes.push({ r, cur: m.cur });
    }
    while (layer.childElementCount < boxes.length) {
      const d = document.createElement("div");
      layer.appendChild(d);
    }
    [...layer.children].forEach((el, i) => {
      const b = boxes[i];
      const d = el as HTMLElement;
      d.hidden = !b;
      if (!b) return;
      const cls = b.cur ? "find-ring cur" : "find-ring";
      if (d.className !== cls) d.className = cls;
      Object.assign(d.style, { left: `${b.r.left - 3}px`, top: `${b.r.top - 2}px`, width: `${b.r.width + 6}px`, height: `${b.r.height + 4}px` });
    });
  };
  const queue = () => {
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const stop = () => {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(raf);
    layer.remove();
    window.removeEventListener("scroll", queue, true);
    window.removeEventListener("resize", queue);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.clearTimeout(timer);
    if (stopCurrent === stop) stopCurrent = null;
  };
  // a click on the page puts the boxes away; a click in the search window (which steps through them) does not
  const onDown = (e: Event) => {
    if (!(e.target as HTMLElement | null)?.closest?.(".fp, .find-layer")) stop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") stop();
  };
  const timer = window.setTimeout(stop, 300_000);
  stopCurrent = stop;
  paint();
  window.addEventListener("scroll", queue, true);
  window.addEventListener("resize", queue);
  // a short grace period: the scroll and the click that brought us here must not dismiss the boxes
  window.setTimeout(() => {
    if (!alive) return;
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  }, refreshing ? 0 : 900);
}
