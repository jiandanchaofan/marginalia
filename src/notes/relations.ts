import { notesStore, type NoteHit } from "./store";
import { notePreview } from "./links";
import { t } from "../i18n";

/**
 * For Markdown export / backup: per note id, one line for each relation it has ("举例：早起实验复盘…").
 * Relations to notes outside the exported set are included too (the other note is looked up for its preview).
 */
export async function relationsFor(hits: NoteHit[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const links = await notesStore.links();
  if (!links.length) return out;
  const inSet = new Set(hits.map((h) => h.note.id));
  const rel = links.filter((l) => inSet.has(l.a) || inSet.has(l.b));
  if (!rel.length) return out;
  const missing = [...new Set(rel.flatMap((l) => [l.a, l.b]))].filter((id) => !inSet.has(id));
  const byId = new Map([...hits, ...(await notesStore.byIds(missing))].map((h) => [h.note.id, h]));
  const add = (id: string, other: string, label: string) => {
    const o = byId.get(other);
    if (!o) return;
    const list = out.get(id) ?? [];
    list.push(`${label || t("export.relatedDefault")}：${notePreview(o.note, 60)}`);
    out.set(id, list);
  };
  for (const l of rel) {
    if (inSet.has(l.a)) add(l.a, l.b, l.label);
    if (inSet.has(l.b)) add(l.b, l.a, l.label);
  }
  return out;
}
