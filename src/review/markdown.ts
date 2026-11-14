import { t } from "../i18n";
import type { NoteHit } from "../notes/store";
import { notePreview } from "../notes/links";
import type { ReviewData } from "./store";

/** The note-review records for the Markdown backup: totals, then one line per note that has been reviewed. */
export function reviewToMarkdown(data: ReviewData, hits: NoteHit[]): string {
  const done = data.items.filter((i) => i.reps > 0);
  if (!done.length) return "";
  const byId = new Map(hits.map((h) => [h.note.id, h.note]));
  const known = data.log.filter((l) => l.rating === 2).length;
  const lines = [`- ${t("md.vsum", { n: data.log.length, notes: done.length, p: data.log.length ? Math.round((known / data.log.length) * 100) : 0 })}`, ""];
  for (const i of [...done].sort((a, b) => (a.last < b.last ? 1 : -1))) {
    const n = byId.get(i.noteId);
    if (!n) continue;
    lines.push(`- ${notePreview(n, 50)} — ${t("md.vline", { reps: i.reps, lapses: i.lapses, last: i.last, due: i.suspended ? t("md.vstop") : i.due })}`);
  }
  return lines.join("\n");
}
