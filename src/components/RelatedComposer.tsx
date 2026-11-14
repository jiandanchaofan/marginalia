import { useRef, useState } from "react";
import { ChevronDown, Hash, ImagePlus, Link2, X } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, type Annotation, type BookRecord } from "../core/types";
import { notesStore, type NoteHit } from "../notes/store";
import { makeLink, notePreview } from "../notes/links";
import { parseTags, stripTags } from "../notes/tags";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { FormatBar } from "./FormatBar";
import { quickLabels, sourceName } from "./LinkDialog";
import { t } from "../i18n";

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SHOWN = 3; // sources listed before the rest are folded away

/**
 * Write a new note that is related to one or more existing notes: it is saved as a standalone note (随手记) and
 * linked to every note it was started from, with the same description of the relation.
 * Layout, top to bottom: where it comes from (folded when long) → how it relates → the writing area → actions.
 */
export function RelatedComposer({ sources, books, onClose, onDone, notify }: { sources: NoteHit[]; books?: Map<string, BookRecord>; onClose(): void; onDone?(created: Annotation): void; notify(msg: string): void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<TagTextareaHandle>(null);
  const canSend = (!!stripTags(text) || images.length > 0) && !busy;
  const listed = all ? sources : sources.slice(0, SHOWN);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const now = Date.now();
      const note = text.trim();
      const a: Annotation = { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note, tags: parseTags(note), side: "right", kind: "free", images, createdAt: now, updatedAt: now };
      await notesStore.add(FREE_BOOK, a);
      await notesStore.putLinks(sources.map((s) => makeLink(a.id, s.note.id, label)));
      notify(t("rc.created", { n: sources.length }));
      onDone?.(a);
      onClose();
    } catch (e) {
      notify(t("rc.saveFail", { err: String(e) }));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal link-dialog related" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>{t("rc.title")}</h2>
        <p className="modal-sub">{t("rc.sub", { many: sources.length > 1 ? t("rc.manyOf", { n: sources.length }) : "" })}</p>

        <div className="rc-cap">{t("rc.source")}</div>
        <div className="rc-sources">
          {listed.map((s) => (
            <div key={s.note.id} className="related-src">
              <span className="rc-src-text">{notePreview(s.note, 240)}</span>
              <span className="rc-src-from">{sourceName(s, books) || t("rc.note")}</span>
            </div>
          ))}
          {sources.length > SHOWN && (
            <button className="rc-more" onClick={() => setAll((v) => !v)}>
              <ChevronDown size={13} style={{ transform: all ? "rotate(180deg)" : undefined }} /> {all ? t("rc.collapse") : t("rc.more", { n: sources.length - SHOWN })}
            </button>
          )}
        </div>

        <div className="rc-cap rc-cap-rel">{t("rc.relCaption")}</div>
        <div className="rc-rel">
          <Link2 size={15} />
          <input className="field-input" value={label} placeholder={t("rc.relPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="link-quick rc-quick">
          {quickLabels().map((l) => (
            <button key={l} className={`tag-chip ${label === l ? "on" : ""}`} onClick={() => setLabel(label === l ? "" : l)}>
              {l}
            </button>
          ))}
        </div>

        <div className="rc-editor">
          <TagTextarea ref={ref} className="note-editor memo-input" value={text} onChange={setText} images={images} onImages={setImages} onImageError={notify} autoFocus placeholder={t("rc.placeholder")} onSubmit={send} />
        </div>

        <div className="rc-foot">
          <button className="memo-tool" title={t("memo.insertTag")} onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.startTag()}>
            <Hash size={16} />
          </button>
          <button className="memo-tool" title={t("card.addImage")} onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.pickImage()}>
            <ImagePlus size={16} />
          </button>
          <FormatBar onFormat={(k) => ref.current?.format(k)} size={15} />
          <span className="nb-spacer" />
          <span className="field-hint">Ctrl + Enter</span>
          <button className="batch-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary-btn" disabled={!canSend} onClick={send}>
            {t("rc.saveLink")}
          </button>
        </div>
      </div>
    </div>
  );
}
