import { useLayoutEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { Annotation, BookRecord, ReadStatus } from "../core/types";
import { STATUS_LABEL, readStatus } from "../core/types";
import { NoteText } from "./NoteText";
import { ReflectBox } from "./ReflectBox";
import { reflectTitleOnTick } from "../tasks/reflect";
import { toggleTodoLine } from "../notes/edit";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { FormatBar } from "./FormatBar";
import { fmtDateTime, t } from "../i18n";

const fmt = (t: number) => {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return fmtDateTime(d, { year: sameYear ? undefined : "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

/** Rating (1–5 stars) and reading status of a book/article. Clicking the current value clears it. */
export function ReadingMeta({ book, onChange }: { book: Pick<BookRecord, "rating" | "status" | "progress">; onChange(patch: { rating?: number; status?: ReadStatus }): void }) {
  const rating = book.rating ?? 0;
  const status = readStatus(book);
  return (
    <div className="reading-meta">
      <div className="stars" role="radiogroup" aria-label={t("doc.rating")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={n <= rating ? "on" : ""} title={n === rating ? t("book.starTipClear", { n }) : t("book.starTip", { n })} onClick={() => onChange({ rating: n === rating ? 0 : n })}>
            <Star size={16} fill={n <= rating ? "currentColor" : "none"} />
          </button>
        ))}
      </div>
      <div className="segmented small">
        {(Object.keys(STATUS_LABEL) as ReadStatus[]).map((s) => (
          <button
            key={s}
            className={status === s ? "on" : ""}
            title={book.status === s ? t("doc.statusAuto") : undefined}
            onClick={() => onChange({ status: book.status === s ? undefined : s })}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  /** Whole-document notes of this book (any order). */
  notes: Annotation[];
  /** "card" = pinned in the margin at the top of the document; "panel" = in a popover / bottom sheet. */
  variant: "card" | "panel";
  noun: string; // 整本书 / 整篇文章
  onAdd(text: string): void;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  onTag?(tag: string): void;
  onHeight?(h: number): void;
  /** Big window only: jump to the full list (the window itself is just the writing sheet). */
  onShowAll?(): void;
}

/** The "整体笔记" list: notes about the whole book/article rather than a passage. Newest first. */
export function DocNotes({ notes, variant, noun, onAdd, onEdit, onDelete, onTag, onHeight, onShowAll }: Props) {
  const sorted = [...notes].sort((a, b) => b.createdAt - a.createdAt);
  const [composing, setComposing] = useState(variant === "panel");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [reflect, setReflect] = useState<{ id: string; title: string } | null>(null); // a todo was just ticked: ask what it taught
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!onHeight || !root.current) return;
    const el = root.current;
    onHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    const text = draft.trim();
    if (text) onAdd(text);
    setDraft("");
    setComposing(variant === "panel"); // the big window keeps the writing box ready
  };
  const saveEdit = () => {
    const text = editDraft.trim();
    if (editingId && text) onEdit(editingId, text);
    setEditingId(null);
  };

  const composeEditor = useRef<TagTextareaHandle>(null);
  const editEditor = useRef<TagTextareaHandle>(null);
  const composer = (
    <div className="doc-compose">
      <TagTextarea
        ref={composeEditor}
        fixed={variant === "panel"}
        className="note-editor"
        value={draft}
        autoFocus
        placeholder={t("doc.placeholder", { noun })}
        onChange={setDraft}
        onSubmit={save}
        // Esc never throws away typed text: with content it only leaves the field; use 取消 to discard.
        onEscape={() => (draft.trim() || variant === "panel" ? (document.activeElement as HTMLElement | null)?.blur() : (setDraft(""), setComposing(false)))}
      />
      <div className="nb-edit-actions">
        <FormatBar onFormat={(k) => composeEditor.current?.format(k)} />
        <span>{t("nb.saveHint")}</span>
        {variant === "card" && (
          <button
            onClick={() => {
              setDraft("");
              setComposing(false);
            }}
          >
            {t("common.cancel")}
          </button>
        )}
        <button className="primary" onClick={save} disabled={!draft.trim()}>
          <Check size={14} /> {t("common.save")}
        </button>
      </div>
    </div>
  );

  return (
    <div ref={root} className={`doc-notes ${variant === "panel" ? "big" : "card"}`}>
      {variant === "card" && (
        <div className="doc-head">
          <span className="doc-title">{t("doc.title")}</span>
          {sorted.length > 0 && <span className="doc-count">{sorted.length}</span>}
          {!composing && (
            <button className="doc-add" title={t("doc.write", { noun })} onClick={() => setComposing(true)}>
              <Plus size={14} />
            </button>
          )}
        </div>
      )}
      {composing && composer}

      {sorted.length === 0 && !composing && variant === "card" && (
        <button className="doc-empty" onClick={() => setComposing(true)}>
          {t("doc.empty", { noun })}
        </button>
      )}

      {variant === "panel" && sorted.length > 0 && (
        <button className="doc-showall" onClick={onShowAll}>
          {t("doc.showAll", { n: sorted.length })}
        </button>
      )}

      <div className="doc-list" hidden={variant === "panel"}>
        {sorted.map((n) =>
          editingId === n.id ? (
            <div key={n.id} className="doc-entry editing">
              <TagTextarea ref={editEditor} fixed={variant === "panel"} className="note-editor" value={editDraft} autoFocus onChange={setEditDraft} onSubmit={saveEdit} onEscape={() => (editDraft !== (notes.find((x) => x.id === editingId)?.note ?? "") ? (document.activeElement as HTMLElement | null)?.blur() : setEditingId(null))} />
              <div className="nb-edit-actions">
                <FormatBar onFormat={(k) => editEditor.current?.format(k)} />
                <span>{t("nb.saveHint")}</span>
                <button onClick={() => setEditingId(null)}>{t("common.cancel")}</button>
                <button className="primary" onClick={saveEdit} disabled={!editDraft.trim()}>
                  <Check size={14} /> {t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <div
              key={n.id}
              className="doc-entry"
              title={t("doc.dblClick")}
              onDoubleClick={(e) => {
                if ((e.target as Element).closest("button, a, textarea, input")) return;
                window.getSelection()?.removeAllRanges();
                setEditDraft(n.note);
                setEditingId(n.id);
              }}
            >
              <NoteText className="doc-text" text={n.note} onTag={onTag} onToggle={(line) => {
                  const title = reflectTitleOnTick(n.note, line);
                  setReflect(title ? { id: n.id, title } : null);
                  onEdit(n.id, toggleTodoLine(n.note, line));
                }} />
              {reflect?.id === n.id && <ReflectBox title={reflect.title} noteId={n.id} onClose={() => setReflect(null)} />}
              <div className="doc-entry-meta">
                <span>{fmt(n.createdAt)}</span>
                <span className="doc-entry-actions">
                  <button
                    title={t("nb.edit")}
                    onClick={() => {
                      setEditDraft(n.note);
                      setEditingId(n.id);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button title={t("card.delete")} className="danger" onClick={() => onDelete(n.id)}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
