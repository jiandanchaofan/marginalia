import { useEffect, useState } from "react";
import { Link2, Search, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import { isFreeNote } from "../core/types";
import { notesStore, type NoteHit } from "../notes/store";
import { hasLink, makeLink, notePreview } from "../notes/links";
import { useLinks } from "../notes/useLinks";
import { t } from "../i18n";
import type { Key } from "../i18n/zh-Hans";

/** Quick relation words, in the current language (they are written into the link, so they follow the UI language). */
export const quickLabels = () => [1, 2, 3, 4, 5, 6].map((n) => t(`linkdlg.l${n}` as Key));

export const sourceName = (hit: NoteHit, books?: Map<string, BookRecord>) => (isFreeNote(hit.note) ? t("kind.free") : books?.get(hit.bookId)?.title ?? "");

/** Connect one note to any number of other notes, with a short description of how they relate. */
export function LinkDialog({ from, books, onClose, notify }: { from: NoteHit; books?: Map<string, BookRecord>; onClose(): void; notify(msg: string): void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<NoteHit[]>([]);
  const [picked, setPicked] = useState<Map<string, NoteHit>>(new Map());
  const [label, setLabel] = useState("");
  const links = useLinks();

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      notesStore.query({ terms: q.trim() ? q.trim().split(/\s+/) : undefined, limit: 40 }).then((r) => alive && setItems(r.items.filter((h) => h.note.id !== from.note.id)));
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q, from.note.id]);

  const toggle = (h: NoteHit) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(h.note.id)) next.delete(h.note.id);
      else next.set(h.note.id, h);
      return next;
    });

  const fresh = [...picked.keys()].filter((id) => !hasLink(links, from.note.id, id, label));
  const save = async () => {
    if (!fresh.length) return;
    try {
      await notesStore.putLinks(fresh.map((id) => makeLink(from.note.id, id, label)));
      notify(t("linkdlg.created", { n: fresh.length }));
      onClose();
    } catch (e) {
      notify(t("linkdlg.fail", { err: String(e) }));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal link-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
        }}
      >
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>
          <Link2 size={18} /> {t("linkdlg.title")}
        </h2>
        <div className="link-from">{t("linkdlg.from", { text: notePreview(from.note, 60) })}</div>
        <label className="field-label">{t("linkdlg.to")}</label>
        <div className="link-search">
          <Search size={14} />
          <input autoFocus placeholder={t("linkdlg.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="link-results">
          {!items.length && <div className="link-empty">{t("linkdlg.none")}</div>}
          {items.map((h) => {
            const on = picked.has(h.note.id);
            return (
              <button key={h.note.id} className={`link-row ${on ? "on" : ""}`} onClick={() => toggle(h)}>
                <span className="link-check">{on ? "✓" : ""}</span>
                <span className="link-text">{notePreview(h.note, 70)}</span>
                <span className="link-src">{sourceName(h, books)}</span>
              </button>
            );
          })}
        </div>
        <label className="field-label">{t("linkdlg.relation")}</label>
        <input className="field-input" value={label} placeholder={t("linkdlg.relationExample")} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <div className="link-quick">
          {quickLabels().map((l) => (
            <button key={l} className={`tag-chip ${label === l ? "on" : ""}`} onClick={() => setLabel(label === l ? "" : l)}>
              {l}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <span className="field-hint">{picked.size && !fresh.length ? t("linkdlg.exists") : t("linkdlg.hint")}</span>
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary-btn" onClick={save} disabled={!fresh.length}>
            {fresh.length ? t("linkdlg.saveN", { n: fresh.length }) : t("linkdlg.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
