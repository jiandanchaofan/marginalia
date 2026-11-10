/**
 * Flomo-style inline tags: `#读书/方法`. A tag starts with '#' at the beginning of the text or after
 * whitespace/punctuation, and runs until whitespace, another '#', or punctuation.
 * Keep in sync with `tag_spans` in src-tauri/src/notes.rs.
 */

const STOP = new Set([..."，。、；：！？,.;:!?()（）[]【】{}<>《》\"'“”‘’…·`~|*"]);
const isStop = (c: string) => /\s/.test(c) || c === "#" || STOP.has(c);

export const normalizeTag = (t: string) =>
  t
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");

export interface TagSpan {
  start: number; // index of '#'
  end: number;
  tag: string;
}

export function tagSpans(text: string): TagSpan[] {
  const out: TagSpan[] = [];
  const chars = Array.from(text);
  let offset = 0;
  const offsets: number[] = [];
  for (const c of chars) {
    offsets.push(offset);
    offset += c.length;
  }
  offsets.push(offset);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "#" || (i > 0 && !isStop(chars[i - 1]))) continue;
    let j = i + 1;
    while (j < chars.length && !isStop(chars[j])) j++;
    const tag = normalizeTag(text.slice(offsets[i] + 1, offsets[j]));
    if (tag) out.push({ start: offsets[i], end: offsets[j], tag });
    i = j - 1;
  }
  return out;
}

export const parseTags = (text: string) => [...new Set(tagSpans(text).map((s) => s.tag))];

/** The note text minus tag tokens — non-empty means the note holds an actual thought. */
export function stripTags(text: string) {
  let out = "";
  let last = 0;
  for (const s of tagSpans(text)) {
    out += text.slice(last, s.start);
    last = s.end;
  }
  return (out + text.slice(last)).trim();
}
export const hasThought = (text: string) => stripTags(text) !== "";

export const isUnder = (tag: string, root: string) => tag === root || tag.startsWith(`${root}/`);

export const tagLeaf = (tag: string) => tag.slice(tag.lastIndexOf("/") + 1);

export type Segment = { kind: "text"; value: string } | { kind: "tag"; value: string; tag: string };

export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const s of tagSpans(text)) {
    if (s.start > last) out.push({ kind: "text", value: text.slice(last, s.start) });
    out.push({ kind: "tag", value: text.slice(s.start, s.end), tag: s.tag });
    last = s.end;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

export interface TagNode {
  tag: string; // full path
  name: string; // leaf segment
  count: number;
  pinned: boolean;
  children: TagNode[];
}

/** Build the tag tree from flat `{tag,count}` rows (ancestors are always present in the rows). */
export function buildTree(rows: { tag: string; count: number; pinned?: boolean }[]): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  for (const r of [...rows].sort((a, b) => a.tag.localeCompare(b.tag, "zh-CN"))) {
    const node: TagNode = { tag: r.tag, name: tagLeaf(r.tag), count: r.count, pinned: !!r.pinned, children: [] };
    nodes.set(r.tag, node);
    const parent = r.tag.includes("/") ? nodes.get(r.tag.slice(0, r.tag.lastIndexOf("/"))) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TagNode[]) => {
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Suggestions for the text typed after '#'. */
export function suggestTags(all: { tag: string; count: number }[], q: string, limit = 8) {
  const query = q.toLowerCase();
  const scored = all
    .map((t) => {
      const tag = t.tag.toLowerCase();
      let score = -1;
      if (!query) score = 1;
      else if (tag === query) score = 4;
      else if (tag.startsWith(query)) score = 3;
      else if (tag.split("/").some((seg) => seg.startsWith(query))) score = 2;
      else if (tag.includes(query)) score = 1;
      return { ...t, score };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.tag.length - b.tag.length);
  return scored.slice(0, limit);
}

/** Remove every token of exactly `tag` (not its children) and tidy the spaces left behind. */
export function removeTag(text: string, tag: string) {
  let next = text;
  for (const s of [...tagSpans(text)].reverse()) if (s.tag === tag) next = next.slice(0, s.start) + next.slice(s.end);
  return next.replace(/[ \t]{2,}/g, " ").replace(/^ +| +$/gm, "");
}

/** Append `#tag` unless the text already carries it. */
export function addTag(text: string, tag: string) {
  const t = normalizeTag(tag.replace(/^#/, ""));
  if (!t || parseTags(text).includes(t)) return text;
  const sep = !text || /\s$/.test(text) ? "" : " ";
  return `${text}${sep}#${t} `;
}
