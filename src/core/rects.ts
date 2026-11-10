import { textNodes } from "./anchor";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Line boxes covered by `range`, relative to `origin`'s top-left.
 * Measures text nodes individually (avoids the element boxes `Range.getClientRects` mixes in)
 * and merges fragments that sit on the same visual line.
 */
export function lineBoxes(range: Range, origin: DOMRect): Box[] {
  const raw: Box[] = [];
  const root = range.commonAncestorContainer;
  const nodes =
    root.nodeType === Node.TEXT_NODE ? [root as Text] : textNodes(root).filter((t) => range.intersectsNode(t));
  const sub = document.createRange();
  for (const t of nodes) {
    const s = t === range.startContainer ? range.startOffset : 0;
    const e = t === range.endContainer ? range.endOffset : t.length;
    if (e <= s) continue;
    sub.setStart(t, s);
    sub.setEnd(t, e);
    for (const r of sub.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      raw.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    }
  }
  raw.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Box[] = [];
  for (const b of raw) {
    const last = lines[lines.length - 1];
    const sameLine =
      last && Math.abs(last.y + last.h / 2 - (b.y + b.h / 2)) < Math.min(last.h, b.h) * 0.6 && b.x <= last.x + last.w + 24;
    if (sameLine) {
      const x1 = Math.min(last.x, b.x);
      const y1 = Math.min(last.y, b.y);
      const x2 = Math.max(last.x + last.w, b.x + b.w);
      const y2 = Math.max(last.y + last.h, b.y + b.h);
      Object.assign(last, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    } else {
      lines.push({ ...b });
    }
  }
  return lines;
}

/** Punctuation and spaces never get emphasis dots (traditional 着重号 convention). */
const NO_DOT = /[\s\p{P}\p{S}]/u;

/** One box per visible, non-punctuation character in `range` (relative to `origin`). */
export function charBoxes(range: Range, origin: DOMRect): Box[] {
  const out: Box[] = [];
  const root = range.commonAncestorContainer;
  const nodes =
    root.nodeType === Node.TEXT_NODE ? [root as Text] : textNodes(root).filter((t) => range.intersectsNode(t));
  const sub = document.createRange();
  for (const t of nodes) {
    const s = t === range.startContainer ? range.startOffset : 0;
    const e = t === range.endContainer ? range.endOffset : t.length;
    for (let i = s; i < e; i++) {
      const code = t.data.charCodeAt(i);
      const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < e;
      const ch = t.data.slice(i, pair ? i + 2 : i + 1);
      if (!NO_DOT.test(ch)) {
        sub.setStart(t, i);
        sub.setEnd(t, i + ch.length);
        const r = sub.getClientRects()[0];
        if (r && r.width > 0.5) out.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
      }
      if (pair) i++;
    }
  }
  return out;
}

export const hitTest = (boxes: Box[], x: number, y: number, pad = 2) =>
  boxes.some((b) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad);
