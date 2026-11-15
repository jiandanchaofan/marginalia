import { t } from "../i18n";
import { moduleName } from "./registry";

/**
 * What to call the document a note belongs to. A note written by a module may belong to a document that has no
 * file (and so is not on the shelf): show the module and the position instead of "removed book".
 */
export function docLabel(title: string | undefined, note: { canonicalRef?: string; sourceModule?: string }): string {
  if (title) return title;
  if (note.sourceModule) return note.canonicalRef ? `${moduleName(note.sourceModule)} · ${note.canonicalRef}` : moduleName(note.sourceModule);
  return t("kind.removedBook");
}
