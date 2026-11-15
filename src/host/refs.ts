import type { LoadedDoc, TextAnchor } from "../core/types";
import { describe, resolve } from "../core/anchor";
import { docProvider, moduleOfDoc } from "./registry";

/**
 * What a note made in a module's document records about where it belongs: the canonical position (read from the
 * `data-ref` attributes of the elements the selection covers) and the module that wrote it.
 * Empty for documents that are not a module's.
 */
export function noteOrigin(docId: string, root: HTMLElement | null, anchor: TextAnchor | null): { canonicalRef?: string; sourceModule?: string; whole?: boolean } {
  const sourceModule = moduleOfDoc(docId);
  if (!sourceModule) return {};
  const out: { canonicalRef?: string; sourceModule?: string; whole?: boolean } = { sourceModule };
  if (!root || !anchor) return out;
  const range = resolve(anchor, root);
  if (!range) return out;
  const els = [...root.querySelectorAll<HTMLElement>("[data-ref]")].filter((el) => range.intersectsNode(el));
  const refs = els.map((el) => el.dataset.ref!);
  if (!refs.length) return out;
  // the words selected are exactly the words of the verses covered: a note on the whole verse(s)
  const squash = (s: string) => s.replace(/\s+/g, "");
  if (anchor.exact && squash(anchor.exact) === squash(els.map((el) => el.textContent ?? "").join(""))) out.whole = true;
  const join = docProvider(docId)?.joinRefs;
  out.canonicalRef = refs.length === 1 ? refs[0] : join ? join(refs) : `${refs[0]}-${refs[refs.length - 1]}`;
  return out;
}

/**
 * References are dotted ("JHN.3.16"); the last part may be a range ("JHN.3.16-18"). Two references overlap when they
 * share everything but the last part and their ranges meet.
 */
export function refsOverlap(a: string, b: string): boolean {
  const split = (r: string) => {
    const parts = r.split(".");
    const last = parts.pop() ?? "";
    const [from, to] = last.split("-");
    return { head: parts.join("."), from: Number(from), to: Number(to ?? from) };
  };
  const x = split(a);
  const y = split(b);
  if (x.head !== y.head || [x.from, x.to, y.from, y.to].some(Number.isNaN)) return false;
  return x.from <= y.to && y.from <= x.to;
}

/** The anchor, in this open document, of the elements that stand for `ref` (a whole verse or run of verses). */
export function anchorOfRef(doc: LoadedDoc, ref: string): TextAnchor | null {
  for (let i = 0; i < doc.sectionCount(); i++) {
    const root = doc.sectionRoot(i);
    if (!root) continue;
    const els = [...root.querySelectorAll<HTMLElement>("[data-ref]")].filter((el) => refsOverlap(el.dataset.ref!, ref));
    if (!els.length) continue;
    const range = document.createRange();
    range.setStart(els[0], 0);
    range.setEnd(els[els.length - 1], els[els.length - 1].childNodes.length);
    const a = describe(range, root, i);
    return a ? { ...a, whole: true } : null;
  }
  return null;
}
