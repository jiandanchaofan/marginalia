import type { TextAnchor } from "./types";

const CONTEXT = 32;

/** Text nodes under `root` in document order, skipping hidden/ignored subtrees. */
export function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (p && p.closest("[data-anchor-ignore]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function sectionText(root: Node): string {
  return textNodes(root)
    .map((t) => t.data)
    .join("");
}

/** Character offset of a (container, offset) boundary point within `root`. */
function offsetOf(root: Node, container: Node, offset: number): number {
  const nodes = textNodes(root);
  // Boundary inside an element: convert to the text position before child[offset].
  if (container.nodeType !== Node.TEXT_NODE) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    // A boundary between elements can't split a text node: count nodes that end before it.
    let total = 0;
    for (const t of nodes) {
      if (range.comparePoint(t, t.length) !== 0) break;
      total += t.length;
    }
    return total;
  }
  let total = 0;
  for (const t of nodes) {
    if (t === container) return total + offset;
    total += t.length;
  }
  return total;
}

export function describe(range: Range, root: HTMLElement, section: number): TextAnchor | null {
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  if (end <= start) return null;
  const text = sectionText(root);
  return {
    section,
    start,
    end,
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(root);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (const t of nodes) {
    const next = pos + t.length;
    if (!started && start < next) {
      range.setStart(t, start - pos);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(t, end - pos);
      return range;
    }
    pos = next;
  }
  return null;
}

/** Common-suffix/prefix length used to score candidate matches. */
function contextScore(text: string, at: number, a: TextAnchor): number {
  let s = 0;
  const before = text.slice(Math.max(0, at - a.prefix.length), at);
  for (let i = 1; i <= Math.min(before.length, a.prefix.length); i++) {
    if (before[before.length - i] !== a.prefix[a.prefix.length - i]) break;
    s++;
  }
  const after = text.slice(at + a.exact.length, at + a.exact.length + a.suffix.length);
  for (let i = 0; i < Math.min(after.length, a.suffix.length); i++) {
    if (after[i] !== a.suffix[i]) break;
    s++;
  }
  return s;
}

/** Re-find an anchor: exact offsets first, then the best-scoring quote match. */
export function resolve(anchor: TextAnchor, root: HTMLElement): Range | null {
  const text = sectionText(root);
  if (text.slice(anchor.start, anchor.end) === anchor.exact) {
    return rangeFromOffsets(root, anchor.start, anchor.end);
  }
  if (!anchor.exact) return null;
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(anchor.exact); i !== -1; i = text.indexOf(anchor.exact, i + 1)) {
    const score = contextScore(text, i, anchor) * 1000 - Math.abs(i - anchor.start) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best < 0 ? null : rangeFromOffsets(root, best, best + anchor.exact.length);
}
