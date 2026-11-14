/** Helpers for note links (relations between notes) and the layout of the relation graph. */
import type { Annotation, GraphPos, NoteLink } from "../core/types";
import { FREE_BOOK } from "../core/types";
import { stripTags } from "./tags";
import { t } from "../i18n";

export const newLinkId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function makeLink(from: string, to: string, label = ""): NoteLink {
  const now = Date.now();
  const [a, b] = from <= to ? [from, to] : [to, from];
  return { id: newLinkId(), a, b, label: label.trim(), createdAt: now, updatedAt: now };
}

/** The note at the other end of `link`, seen from `noteId`. */
export const otherEnd = (link: NoteLink, noteId: string) => (link.a === noteId ? link.b : link.a);

export const linksOf = (links: NoteLink[], noteId: string) => links.filter((l) => l.a === noteId || l.b === noteId);

/** Number of links per note (for badges). */
export function linkCounts(links: NoteLink[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of links) {
    out.set(l.a, (out.get(l.a) ?? 0) + 1);
    out.set(l.b, (out.get(l.b) ?? 0) + 1);
  }
  return out;
}

/** Same pair, same words: the interface refuses to add it twice. */
export const hasLink = (links: NoteLink[], x: string, y: string, label: string) =>
  links.some((l) => ((l.a === x && l.b === y) || (l.a === y && l.b === x)) && l.label === label.trim());

/** One-line preview of a note for lists and graph nodes. */
export function notePreview(a: Annotation, max = 40): string {
  const text = stripTags(a.note).replace(/\s+/g, " ").trim();
  const quote = a.anchor.exact?.replace(/\s+/g, " ").trim() ?? "";
  const s = text || quote || (a.images?.length ? t("note.imageTag") : a.anchor.region ? t("note.regionTag") : t("note.empty"));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const isFree = (bookId: string) => bookId === FREE_BOOK;

/**
 * Notes reachable from `start` through at most `depth` links (start included).
 * Used by "show neighbours" in the graph.
 */
export function neighbourhood(links: NoteLink[], start: string[], depth: number): Set<string> {
  const seen = new Set(start);
  let frontier = [...start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const l of links) {
      for (const [x, y] of [[l.a, l.b], [l.b, l.a]] as const) {
        if (frontier.includes(x) && !seen.has(y)) {
          seen.add(y);
          next.push(y);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// ------------------------------------------------------------------ graph layout

export interface Pt {
  x: number;
  y: number;
}

/**
 * Force-directed layout: nodes repel, links pull. Nodes in `fixed` (already placed by the user) do not move.
 * Deterministic for the same input (initial positions come from a hash of the id), so a graph does not shuffle
 * itself between visits. O(n²) per step — fine for a few hundred nodes.
 */
export function layout(ids: string[], links: NoteLink[], saved: Map<string, Pt>, sizes?: Map<string, Size>, steps = Math.max(80, Math.min(220, Math.round(60000 / Math.max(1, ids.length))))): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const fixed = new Set<string>();
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  };
  const radius = 160 + Math.sqrt(ids.length) * 130;
  for (const id of ids) {
    const s = saved.get(id);
    if (s) {
      pos.set(id, { ...s });
      fixed.add(id);
    } else {
      const ang = hash(id) * Math.PI * 2;
      const r = radius * (0.35 + 0.65 * hash(id + "r"));
      pos.set(id, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
  }
  const free = ids.filter((id) => !fixed.has(id));
  if (!free.length) return pos;
  const edges = links.filter((l) => pos.has(l.a) && pos.has(l.b));
  const rest = 430; // natural length of a link: wider than a card, so lines have room to pass between cards
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    const force = new Map<string, Pt>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = pos.get(ids[i])!;
        const q = pos.get(ids[j])!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 1000000) continue; // far apart: ignore
        if (d2 < 1) {
          dx = hash(ids[i]) - 0.5;
          dy = hash(ids[j]) - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = 100000 / d2;
        force.get(ids[i])!.x += (dx / d) * f;
        force.get(ids[i])!.y += (dy / d) * f;
        force.get(ids[j])!.x -= (dx / d) * f;
        force.get(ids[j])!.y -= (dy / d) * f;
      }
    }
    for (const l of edges) {
      const p = pos.get(l.a)!;
      const q = pos.get(l.b)!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - rest) * 0.04;
      force.get(l.a)!.x += (dx / d) * f;
      force.get(l.a)!.y += (dy / d) * f;
      force.get(l.b)!.x -= (dx / d) * f;
      force.get(l.b)!.y -= (dy / d) * f;
    }
    for (const id of free) {
      const f = force.get(id)!;
      const p = pos.get(id)!;
      p.x += f.x * 0.9 * cool - p.x * 0.004; // a light pull to the centre keeps loose pieces together
      p.y += f.y * 0.9 * cool - p.y * 0.004;
    }
  }
  separate(pos, new Set(free), sizes);
  if (free.length > 1 && edges.length <= 600) reduceCrossings(pos, free, edges, sizes);
  separate(pos, new Set(free), sizes);
  return pos;
}

// ------------------------------------------------------------------ keep cards apart

/** Pushes overlapping cards apart (along the direction of least overlap); cards not in `movable` stay put. */
function separate(pos: Map<string, Pt>, movable: Set<string>, sizes?: Map<string, Size>) {
  const ids = [...pos.keys()];
  for (let round = 0; round < 80; round++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = pos.get(ids[i])!;
        const q = pos.get(ids[j])!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const si = sizeOf(sizes, ids[i]);
        const sj = sizeOf(sizes, ids[j]);
        const ox = (si.w + sj.w) / 2 + 28 - Math.abs(dx);
        const oy = (si.h + sj.h) / 2 + 22 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const mi = movable.has(ids[i]);
        const mj = movable.has(ids[j]);
        if (!mi && !mj) continue;
        const shareI = mi && mj ? 0.5 : mi ? 1 : 0;
        const shareJ = 1 - shareI;
        // separate along the axis that needs the smaller push; exact overlaps are split by a hash of the ids
        if (ox < oy) {
          const s = dx === 0 ? (ids[i] < ids[j] ? -1 : 1) : Math.sign(dx);
          p.x -= s * ox * shareI;
          q.x += s * ox * shareJ;
        } else {
          const s = dy === 0 ? (ids[i] < ids[j] ? -1 : 1) : Math.sign(dy);
          p.y -= s * oy * shareI;
          q.y += s * oy * shareJ;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// ------------------------------------------------------------------ fewer crossings

/** Size of a card in the graph (also used to keep cards from overlapping and to anchor lines on their sides). */
export const CARD_W = 250; // default card: room for 45 characters, 15 per line x 3 lines
export const CARD_H = 74;
export const DOT = 18; // the smallest a card can be: a dot
export interface Size {
  w: number;
  h: number;
}
const sizeOf = (sizes: Map<string, Size> | undefined, id: string): Size => sizes?.get(id) ?? { w: CARD_W, h: CARD_H };

const orient = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Do segments ab and cd properly cross (touching at an end does not count)? */
export function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Local search on a finished layout: moving a card a little, or swapping two cards, is kept when it lowers the number
 * of crossings between straight links (and never lets two cards overlap). Only cards in `free` move.
 */
function reduceCrossings(pos: Map<string, Pt>, free: string[], edges: NoteLink[], sizes?: Map<string, Size>) {
  const incident = new Map<string, NoteLink[]>();
  for (const l of edges) {
    incident.set(l.a, [...(incident.get(l.a) ?? []), l]);
    incident.set(l.b, [...(incident.get(l.b) ?? []), l]);
  }
  const crossings = (set: NoteLink[]) => {
    let n = 0;
    for (const e of set) {
      const a = pos.get(e.a)!;
      const b = pos.get(e.b)!;
      for (const f of edges) {
        if (f === e || f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
        if (segCross(a, b, pos.get(f.a)!, pos.get(f.b)!)) n++;
      }
    }
    return n;
  };
  const clear = (id: string, at: Pt) => {
    const me = sizeOf(sizes, id);
    for (const [other, q] of pos) {
      if (other === id) continue;
      const o = sizeOf(sizes, other);
      if (Math.abs(q.x - at.x) < (me.w + o.w) / 2 + 24 && Math.abs(q.y - at.y) < (me.h + o.h) / 2 + 20) return false;
    }
    return true;
  };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const v of free) {
      const mine = incident.get(v) ?? [];
      if (!mine.length) continue;
      const pv = pos.get(v)!;
      const base = crossings(mine);
      if (base === 0) continue;
      let best = base;
      let move: { to?: Pt; swap?: string } | null = null;
      for (const r of [80, 160, 260]) {
        for (const [dx, dy] of dirs) {
          const to = { x: pv.x + dx * r, y: pv.y + dy * r };
          if (!clear(v, to)) continue;
          const keep = { ...pv };
          pv.x = to.x;
          pv.y = to.y;
          const score = crossings(mine);
          pv.x = keep.x;
          pv.y = keep.y;
          if (score < best) {
            best = score;
            move = { to };
          }
        }
      }
      const near = free
        .filter((w) => w !== v)
        .sort((x, y) => Math.hypot(pos.get(x)!.x - pv.x, pos.get(x)!.y - pv.y) - Math.hypot(pos.get(y)!.x - pv.x, pos.get(y)!.y - pv.y))
        .slice(0, 8);
      for (const w of near) {
        const pw = pos.get(w)!;
        const both = [...new Set([...mine, ...(incident.get(w) ?? [])])];
        const before = crossings(both);
        const a = { ...pv };
        const b = { ...pw };
        pv.x = b.x; pv.y = b.y; pw.x = a.x; pw.y = a.y;
        const after = crossings(both);
        pv.x = a.x; pv.y = a.y; pw.x = b.x; pw.y = b.y;
        // a swap is judged on both cards' links; compare the gain with the best plain move
        if (before - after > base - best) {
          best = base - (before - after);
          move = { swap: w };
        }
      }
      if (move?.to) {
        pv.x = move.to.x;
        pv.y = move.to.y;
        improved = true;
      } else if (move?.swap) {
        const pw = pos.get(move.swap)!;
        const a = { ...pv };
        pv.x = pw.x; pv.y = pw.y; pw.x = a.x; pw.y = a.y;
        improved = true;
      }
    }
    if (!improved) break;
  }
}

export const toSaved = (list: GraphPos[]) => new Map(list.map((p) => [p.noteId, { x: p.x, y: p.y }]));

// ------------------------------------------------------------------ curves

export const LINK_STYLES: { key: "solid" | "dashed" | "dotted"; name: string; dash: string }[] = [
  { key: "solid", get name() { return t("link.solid"); }, dash: "" },
  { key: "dashed", get name() { return t("link.dashed"); }, dash: "8 6" },
  { key: "dotted", get name() { return t("link.dotted"); }, dash: "1.5 6" },
];
export const dashOf = (style?: string) => LINK_STYLES.find((s) => s.key === style)?.dash ?? "";

/** SVG path of a link from p to q bent by `bend`, and the point halfway along it (for the label). */
export function curve(p: Pt, q: Pt, bend: number): { d: string; mid: Pt } {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const cx = (p.x + q.x) / 2 + (-dy / len) * bend * 2; // a quadratic curve peaks halfway to its control point
  const cy = (p.y + q.y) / 2 + (dx / len) * bend * 2;
  return {
    d: `M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`,
    mid: { x: (p.x + q.x) / 2 + (-dy / len) * bend, y: (p.y + q.y) / 2 + (dx / len) * bend },
  };
}

// ------------------------------------------------------------------ line shapes and routing

/** How links are drawn, after the connection lines of mind-map tools. */
export type Shape = "arc" | "flow" | "elbow" | "straight";
export const SHAPES: { key: Shape; name: string }[] = [
  { key: "arc", get name() { return t("shape.arc"); } },
  { key: "flow", get name() { return t("shape.flow"); } },
  { key: "elbow", get name() { return t("shape.elbow"); } },
  { key: "straight", get name() { return t("shape.straight"); } },
];

export interface Geo {
  d: string; // SVG path
  mid: Pt; // where the label sits
  pts: Pt[]; // the line sampled as a polyline (crossing / card tests)
}


export type Side = "" | "t" | "r" | "b" | "l";
const SIDE_DIR: Record<string, Pt> = { t: { x: 0, y: -1 }, r: { x: 1, y: 0 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 } };

/** The middle of one side (top / right / bottom / left) of a card centred at `c`. */
export function anchorAt(c: Pt, s: Size, side: string): Pt {
  const d = SIDE_DIR[side];
  return { x: c.x + d.x * (s.w / 2), y: c.y + d.y * (s.h / 2) };
}

/** Automatic choice: the sides that face each other — left / right when the cards are side by side, top / bottom otherwise. */
function autoSides(p: Pt, q: Pt, sp: Size, sq: Size): [Side, Side] {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (Math.abs(dx) < ((sp.w + sq.w) / 2) * 0.9) return dy >= 0 ? ["b", "t"] : ["t", "b"];
  return dx >= 0 ? ["r", "l"] : ["l", "r"];
}
/** The side of a card (centre c, size s) that points at `t`. */
function facing(c: Pt, s: Size, t: Pt): Side {
  const dx = t.x - c.x;
  const dy = t.y - c.y;
  if (Math.abs(dx) * s.h >= Math.abs(dy) * s.w) return dx >= 0 ? "r" : "l";
  return dy >= 0 ? "b" : "t";
}

/** The side each end of a link really leaves from (what the user pinned, or what the automatic choice picks). */
export function effectiveSides(shape: Shape, p: Pt, q: Pt, sp: Size, sq: Size, sideA: Side = "", sideB: Side = ""): [Side, Side] {
  let sa = sideA;
  let sb = sideB;
  if (!sa && !sb) [sa, sb] = shape === "flow" || shape === "elbow" ? autoSides(p, q, sp, sq) : [facing(p, sp, q), facing(q, sq, p)];
  else if (!sa) sa = facing(p, sp, anchorAt(q, sq, sb));
  else if (!sb) sb = facing(q, sq, anchorAt(p, sp, sa));
  return [sa, sb];
}

const f1 = (n: number) => n.toFixed(1);
const pt = (t: Pt) => `${f1(t.x)} ${f1(t.y)}`;

/** A polyline with rounded corners, and the point halfway along it. */
function rounded(points: Pt[], radius: number): { d: string; mid: Pt } {
  const P = points.filter((t, i) => i === 0 || Math.hypot(t.x - points[i - 1].x, t.y - points[i - 1].y) > 0.5);
  if (P.length < 3) return { d: `M${pt(P[0])} L${pt(P[P.length - 1])}`, mid: { x: (P[0].x + P[P.length - 1].x) / 2, y: (P[0].y + P[P.length - 1].y) / 2 } };
  let d = `M${pt(P[0])}`;
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1];
    const c = P[i];
    const b = P[i + 1];
    const la = Math.hypot(c.x - a.x, c.y - a.y);
    const lb = Math.hypot(b.x - c.x, b.y - c.y);
    const r = Math.min(radius, la / 2, lb / 2);
    d += ` L${pt({ x: c.x + ((a.x - c.x) / la) * r, y: c.y + ((a.y - c.y) / la) * r })} Q${pt(c)} ${pt({ x: c.x + ((b.x - c.x) / lb) * r, y: c.y + ((b.y - c.y) / lb) * r })}`;
  }
  d += ` L${pt(P[P.length - 1])}`;
  // midpoint by length
  let total = 0;
  for (let i = 1; i < P.length; i++) total += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  let walk = total / 2;
  let mid = P[0];
  for (let i = 1; i < P.length; i++) {
    const len = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    if (walk <= len) {
      mid = { x: P[i - 1].x + ((P[i].x - P[i - 1].x) * walk) / (len || 1), y: P[i - 1].y + ((P[i].y - P[i - 1].y) * walk) / (len || 1) };
      break;
    }
    walk -= len;
  }
  return { d, mid };
}

/**
 * The path of a link in the given shape. `param` is the bend / offset chosen by the router (0 = the natural one).
 * `sideA` / `sideB` fix where the line leaves each card (top / right / bottom / left); "" = automatic.
 */
export function geom(shape: Shape, p: Pt, q: Pt, param: number, sp: Size = { w: CARD_W, h: CARD_H }, sq: Size = { w: CARD_W, h: CARD_H }, sideA: Side = "", sideB: Side = ""): Geo {
  if (shape === "arc" || shape === "straight") {
    // centre to centre, unless an end is pinned to a side
    const P = sideA ? anchorAt(p, sp, sideA) : p;
    const Q = sideB ? anchorAt(q, sq, sideB) : q;
    if (shape === "straight" && !param) return { d: `M${pt(P)} L${pt(Q)}`, mid: { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 }, pts: [P, Q] };
    const c = curve(P, Q, param);
    const dx = Q.x - P.x;
    const dy = Q.y - P.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ctrl = { x: (P.x + Q.x) / 2 + (-dy / len) * param * 2, y: (P.y + Q.y) / 2 + (dx / len) * param * 2 };
    const pts: Pt[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push({ x: (1 - t) * (1 - t) * P.x + 2 * (1 - t) * t * ctrl.x + t * t * Q.x, y: (1 - t) * (1 - t) * P.y + 2 * (1 - t) * t * ctrl.y + t * t * Q.y });
    }
    return { ...c, pts };
  }
  let sa: Side = sideA;
  let sb: Side = sideB;
  if (!sa && !sb) [sa, sb] = autoSides(p, q, sp, sq);
  else if (!sa) sa = facing(p, sp, anchorAt(q, sq, sb));
  else if (!sb) sb = facing(q, sq, anchorAt(p, sp, sa));
  const A = anchorAt(p, sp, sa);
  const B = anchorAt(q, sq, sb);
  const dA = SIDE_DIR[sa];
  const dB = SIDE_DIR[sb];
  if (shape === "flow") {
    // the classic mind-map curve: leaves each card straight out of its side, an S (or a loop-free arch) in between
    const dist = Math.hypot(B.x - A.x, B.y - A.y);
    const h = Math.max(40, Math.min(dist * 0.5, 220));
    const len = Math.max(1, dist);
    const n = { x: (-(B.y - A.y) / len) * param, y: ((B.x - A.x) / len) * param };
    const c1 = { x: A.x + dA.x * h + n.x, y: A.y + dA.y * h + n.y };
    const c2 = { x: B.x + dB.x * h + n.x, y: B.y + dB.y * h + n.y };
    const at = (t: number): Pt => {
      const u = 1 - t;
      return {
        x: u * u * u * A.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * B.x,
        y: u * u * u * A.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * B.y,
      };
    };
    const pts: Pt[] = [];
    for (let i = 0; i <= 20; i++) pts.push(at(i / 20));
    return { d: `M${pt(A)} C${pt(c1)} ${pt(c2)} ${pt(B)}`, mid: at(0.5), pts };
  }
  // elbow: straight runs with rounded corners
  const horiz = (side: Side) => side === "l" || side === "r";
  let pts: Pt[];
  if (horiz(sa) && horiz(sb)) {
    const facingEach = dA.x === -dB.x && Math.sign(B.x - A.x) === dA.x;
    const mx = facingEach ? (A.x + B.x) / 2 + param : (dA.x > 0 ? Math.max(A.x, B.x) : Math.min(A.x, B.x)) + dA.x * (28 + Math.abs(param));
    pts = [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B];
  } else if (!horiz(sa) && !horiz(sb)) {
    const facingEach = dA.y === -dB.y && Math.sign(B.y - A.y) === dA.y;
    const my = facingEach ? (A.y + B.y) / 2 + param : (dA.y > 0 ? Math.max(A.y, B.y) : Math.min(A.y, B.y)) + dA.y * (28 + Math.abs(param));
    pts = [A, { x: A.x, y: my }, { x: B.x, y: my }, B];
  } else if (horiz(sa)) pts = [A, { x: B.x, y: A.y }, B];
  else pts = [A, { x: A.x, y: B.y }, B];
  const r = rounded(pts, 14);
  return { d: r.d, mid: r.mid, pts };
}

export interface Route {
  param: number;
  geo: Geo;
}

const bbox = (pts: Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of pts) {
    if (t.x < x0) x0 = t.x;
    if (t.x > x1) x1 = t.x;
    if (t.y < y0) y0 = t.y;
    if (t.y > y1) y1 = t.y;
  }
  return { x0, y0, x1, y1 };
};
const overlap = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Above this many links the search for crossing-free routes is skipped (the natural routes are used). */
const ROUTE_LIMIT = 250;

/**
 * Decides how every link is drawn. A lone link takes the natural line of the shape; several links between the same two
 * notes fan out. When a line would cross another line or run over a card that is not one of its ends, a few other bends
 * are tried and the one with the fewest collisions wins (longest links are placed first, so short ones go around them).
 */
export function routeAll(links: NoteLink[], pos: Map<string, Pt>, shape: Shape, sizes?: Map<string, Size>): Map<string, Route> {
  const out = new Map<string, Route>();
  const groups = new Map<string, NoteLink[]>();
  for (const l of links) {
    if (!pos.has(l.a) || !pos.has(l.b)) continue;
    groups.set(`${l.a}|${l.b}`, [...(groups.get(`${l.a}|${l.b}`) ?? []), l]);
  }
  // natural parameter of each link
  const base = new Map<string, number>();
  for (const [, list] of groups) {
    const p = pos.get(list[0].a)!;
    const q = pos.get(list[0].b)!;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    const lone = shape === "arc" ? Math.min(70, Math.max(18, d * 0.16)) : 0;
    const gap = shape === "arc" || shape === "straight" ? Math.min(46, Math.max(26, d * 0.1)) : 34;
    list.forEach((l, i) => base.set(l.id, list.length === 1 ? lone : (i - (list.length - 1) / 2) * gap + (shape === "arc" ? lone * 0.4 : 0)));
  }
  const list = [...groups.values()].flat();
  const optimise = list.length <= ROUTE_LIMIT;
  const step = shape === "arc" ? 24 : 38;
  const cards = [...pos].map(([id, c]) => ({ id, x: c.x, y: c.y, ...sizeOf(sizes, id) }));
  const placed: { a: string; b: string; pts: Pt[]; box: ReturnType<typeof bbox> }[] = [];
  const chord = (l: NoteLink) => Math.hypot(pos.get(l.a)!.x - pos.get(l.b)!.x, pos.get(l.a)!.y - pos.get(l.b)!.y);
  for (const l of [...list].sort((x, y) => chord(y) - chord(x))) {
    const p = pos.get(l.a)!;
    const q = pos.get(l.b)!;
    const b0 = base.get(l.id) ?? 0;
    const sp = sizeOf(sizes, l.a);
    const sq = sizeOf(sizes, l.b);
    let best = geom(shape, p, q, b0, sp, sq, l.sideA ?? "", l.sideB ?? "");
    let bestParam = b0;
    if (optimise && !(shape === "straight")) {
      let bestCost = Infinity;
      for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
        const param = b0 + k * step;
        const g = k === 0 ? best : geom(shape, p, q, param, sp, sq, l.sideA ?? "", l.sideB ?? "");
        const box = bbox(g.pts);
        let cost = Math.abs(k) * 0.6;
        for (const o of placed) {
          if (o.a === l.a || o.a === l.b || o.b === l.a || o.b === l.b || !overlap(box, o.box)) continue;
          cross: for (let i = 0; i < g.pts.length - 1; i++)
            for (let j = 0; j < o.pts.length - 1; j++)
              if (segCross(g.pts[i], g.pts[i + 1], o.pts[j], o.pts[j + 1])) {
                cost += 12;
                continue cross;
              }
        }
        for (const c of cards) {
          if (c.id === l.a || c.id === l.b) continue;
          const rect = { x0: c.x - c.w / 2 - 6, x1: c.x + c.w / 2 + 6, y0: c.y - c.h / 2 - 6, y1: c.y + c.h / 2 + 6 };
          if (!overlap(box, rect)) continue;
          if (g.pts.some((t) => t.x > rect.x0 && t.x < rect.x1 && t.y > rect.y0 && t.y < rect.y1)) cost += 40;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = g;
          bestParam = param;
        }
        if (cost === 0) break; // nothing in the way: no need to look further
      }
    }
    out.set(l.id, { param: bestParam, geo: best });
    placed.push({ a: l.a, b: l.b, pts: best.pts, box: bbox(best.pts) });
  }
  return out;
}
