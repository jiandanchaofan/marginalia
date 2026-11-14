import { useState } from "react";
import { Sparkles } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, type Annotation } from "../core/types";
import { notesStore } from "../notes/store";
import { makeLink } from "../notes/links";
import { parseTags, stripTags } from "../notes/tags";
import { t } from "../i18n";
import { reviewTag } from "../tasks/words";

const MUTE = "reader:reflect-muted";
export const reflectMuted = () => {
  try {
    return localStorage.getItem(MUTE) === "1";
  } catch {
    return false;
  }
};
export const setReflectMuted = (muted: boolean) => {
  try {
    if (muted) localStorage.setItem(MUTE, "1");
    else localStorage.removeItem(MUTE);
  } catch {
    /* storage unavailable */
  }
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Sits right under a todo that was just ticked: a few lines for what the doing taught.
 * Saving makes a standalone note linked to the note the todo was written in (read → think → do → reflect).
 */
export function ReflectBox({ title, noteId, notify, onClose }: { title: string; noteId: string; notify?(msg: string): void; onClose(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const can = !!stripTags(text) && !busy;

  const save = async () => {
    if (!can) return;
    setBusy(true);
    try {
      const now = Date.now();
      // line 1: the tags and the todo's name; line 2: what the user wrote
      const note = `#${reviewTag()} ${t("reflect.intro", { title })}\n${text.trim()}`;
      const a: Annotation = { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note, tags: parseTags(note), side: "right", kind: "free", createdAt: now, updatedAt: now };
      await notesStore.add(FREE_BOOK, a);
      await notesStore.putLinks([makeLink(a.id, noteId, t("reflect.linkLabel"))]);
      notify?.(t("reflect.saved"));
      setSaved(true);
      setTimeout(onClose, 1300);
    } catch (e) {
      notify?.(t("reflect.saveFail", { err: String(e) }));
      setBusy(false);
    }
  };
  const mute = () => {
    setReflectMuted(true);
    onClose();
  };

  if (saved)
    return (
      <div className="reflect-box saved" onClick={(e) => e.stopPropagation()}>
        <div className="reflect-head">
          <Sparkles size={13} /> {t("reflect.saved")}
        </div>
      </div>
    );
  return (
    <div className="reflect-box" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="reflect-head">
        <Sparkles size={13} /> {t("reflect.head")}
      </div>
      <textarea
        className="reflect-input"
        rows={3}
        autoFocus
        value={text}
        placeholder={t("reflect.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="reflect-foot">
        <button className="reflect-mute" onClick={mute} title={t("reflect.muteTip")}>
          {t("reflect.mute")}
        </button>
        <span className="reflect-spacer" />
        <span className="reflect-hint">Ctrl + Enter</span>
        <button className="reflect-btn" onClick={onClose}>
          {t("reflect.skip")}
        </button>
        <button className="reflect-btn primary" disabled={!can} onClick={save}>
          {t("reflect.save")}
        </button>
      </div>
    </div>
  );
}
