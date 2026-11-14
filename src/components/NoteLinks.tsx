import { useMemo, useState } from "react";
import { FilePlus2, Link2, Plus, X } from "lucide-react";
import type { BookRecord, NoteLink } from "../core/types";
import { notesStore, type NoteHit } from "../notes/store";
import { notePreview, otherEnd } from "../notes/links";
import { useNotesById } from "../notes/useLinks";
import { sourceName } from "./LinkDialog";
import { t } from "../i18n";

/** The relations of one note: who it is connected to and how. The description of each link is editable in place. */
export function NoteLinks({
  noteId,
  links,
  books,
  onOpenNote,
  onAdd,
  onRelated,
  notify,
}: {
  noteId: string;
  links: NoteLink[];
  books?: Map<string, BookRecord>;
  onOpenNote?(hit: NoteHit): void;
  onAdd(): void;
  onRelated(): void;
  notify?(msg: string): void;
}) {
  const others = useMemo(() => links.map((l) => otherEnd(l, noteId)), [links, noteId]);
  const hits = useNotesById(others);
  const [editing, setEditing] = useState<string | null>(null);

  const saveLabel = async (l: NoteLink, label: string) => {
    setEditing(null);
    if (label.trim() === l.label) return;
    try {
      await notesStore.putLinks([{ ...l, label, updatedAt: Date.now() }]);
    } catch (e) {
      notify?.(t("links.saveFail", { err: String(e) }));
    }
  };

  return (
    <div className="note-links" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="nl-head">
        <Link2 size={13} />
        <span>{links.length ? t("links.titleN", { n: links.length }) : t("links.title")}</span>
        <span className="nb-spacer" />
        <button className="nl-btn" onClick={onAdd} title={t("links.addTip")}>
          <Plus size={13} /> {t("links.add")}
        </button>
        <button className="nl-btn" onClick={onRelated} title={t("links.relatedTip")}>
          <FilePlus2 size={13} /> {t("links.related")}
        </button>
      </div>
      {!links.length && <div className="nl-empty">{t("links.empty")}</div>}
      {links.map((l) => {
        const hit = hits.get(otherEnd(l, noteId));
        return (
          <div key={l.id} className="nl-row">
            {editing === l.id ? (
              <input
                className="nl-label-input"
                autoFocus
                defaultValue={l.label}
                placeholder={t("links.labelPlaceholder")}
                onBlur={(e) => saveLabel(l, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <button className={`nl-label ${l.label ? "" : "empty"}`} title={t("links.labelEdit")} onClick={() => setEditing(l.id)}>
                {l.label || t("links.unlabeled")}
              </button>
            )}
            <button className="nl-target" disabled={!hit || !onOpenNote} onClick={() => hit && onOpenNote?.(hit)} title={hit ? notePreview(hit.note, 200) : t("links.gone")}>
              <span className="nl-text">{hit ? notePreview(hit.note, 80) : t("links.notFound")}</span>
              {hit && <span className="nl-src">{sourceName(hit, books)}</span>}
            </button>
            <button className="nl-del" title={t("links.delete")} onClick={() => notesStore.removeLink(l.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
