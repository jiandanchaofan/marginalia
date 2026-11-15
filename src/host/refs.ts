import type { TextAnchor } from "../core/types";
import { resolve } from "../core/anchor";
import { docProvider, moduleOfDoc } from "./registry";

/**
 * What a note made in a module's document records about where it belongs: the canonical position (read from the
 * `data-ref` attributes of the elements the selection covers) and the module that wrote it.
 * Empty for documents that are not a module's.
 */
export function noteOrigin(docId: string, root: HTMLElement | null, anchor: TextAnchor | null): { canonicalRef?: string; sourceModule?: string } {
  const sourceModule = moduleOfDoc(docId);
  if (!sourceModule) return {};
  const out: { canonicalRef?: string; sourceModule?: string } = { sourceModule };
  if (!root || !anchor) return out;
  const range = resolve(anchor, root);
  if (!range) return out;
  const refs = [...root.querySelectorAll<HTMLElement>("[data-ref]")].filter((el) => range.intersectsNode(el)).map((el) => el.dataset.ref!);
  if (!refs.length) return out;
  const join = docProvider(docId)?.joinRefs;
  out.canonicalRef = refs.length === 1 ? refs[0] : join ? join(refs) : `${refs[0]}-${refs[refs.length - 1]}`;
  return out;
}
