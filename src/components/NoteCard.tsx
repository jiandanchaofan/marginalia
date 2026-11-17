import { isDarkTheme } from "../settings";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { docShortLabel } from "../host/registry";
import { ArrowLeftRight, Hash, ImagePlus, Palette, Trash2 } from "lucide-react";
import type { Annotation, HighlightStyle } from "../core/types";
import { PALETTE, STYLES, swatch } from "../core/palette";
import type { Theme } from "../settings";
import { StylePreview } from "./StylePreview";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { NoteText } from "./NoteText";
import { FormatBar } from "./FormatBar";
import { NoteImages, RegionQuote } from "./NoteImages";
import { toggleTodoLine } from "../notes/edit";
import { reflectTitleOnTick } from "../tasks/reflect";
import { ReflectBox } from "./ReflectBox";
import { fmtDateTime, t } from "../i18n";

interface Props {
  a: Annotation;
  theme: Theme;
  active: boolean;
  autoFocus: boolean;
  variant: "margin" | "sheet";
  side?: "left" | "right";
  canSwapSide?: boolean;
  onSwapSide?(): void;
  style?: React.CSSProperties;
  onActivate(): void;
  onChange(patch: Partial<Annotation>): void;
  onDelete(): void;
  onHeight?(h: number): void;
  onTag?(tag: string): void;
  /** Ctrl+Enter: finish writing and show the card in its read-only form. */
  onDone?(): void;
}

const fmt = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return fmtDateTime(d, { year: sameYear ? undefined : "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

export function NoteCard({ a, theme, active, autoFocus, variant, side, canSwapSide, onSwapSide, style, onActivate, onChange, onDelete, onHeight, onTag, onDone }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const editor = useRef<TagTextareaHandle>(null);
  const [reflect, setReflect] = useState<string | null>(null);
  /** Colour and style choices stay folded away until asked for. */
  const [look, setLook] = useState(false);
  useEffect(() => {
    if (!active) setLook(false);
  }, [active]);
  const sw = swatch(a.color);
  const accent = isDarkTheme(theme) ? sw.dark : sw.ink;

  useLayoutEffect(() => {
    if (!onHeight || !ref.current) return;
    const el = ref.current;
    onHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className={`note-card ${variant === "sheet" ? "in-sheet" : "margin"} ${side ?? ""} ${active ? "active" : ""}`}
      style={{ ...style, ["--accent" as string]: accent, ["--tint" as string]: isDarkTheme(theme) ? `${sw.dark}22` : `${sw.light}66` }}
      onMouseDown={(e) => {
        if (!active) {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {a.fromDoc && docShortLabel(a.fromDoc) && <div className="note-from">{t("note.fromDoc", { name: docShortLabel(a.fromDoc) })}</div>}
      {a.anchor.region ? <RegionQuote id={a.anchor.thumb} page={a.anchor.image ? undefined : a.anchor.section} className="region-quote small" /> : <div className="note-quote">{a.anchor.exact}</div>}
      {active ? (
        <TagTextarea
          ref={editor}
          className="note-editor"
          placeholder={t("card.placeholder")}
          value={a.note}
          autoFocus={autoFocus}
          onChange={(note) => onChange({ note })}
          images={a.images}
          onImages={(images) => onChange({ images })}
          onEscape={() => (document.activeElement as HTMLElement | null)?.blur()}
          // Notes save as you type; Ctrl+Enter finishes: leave the field and drop back to the display state.
          onSubmit={() => {
            (document.activeElement as HTMLElement | null)?.blur();
            onDone?.();
          }}
        />
      ) : (
        <>
          {a.note && <NoteText text={a.note} onTag={onTag} onToggle={(line) => {
              const title = reflectTitleOnTick(a.note, line);
              onChange({ note: toggleTodoLine(a.note, line) });
              setReflect(title || null);
            }} />}
          <NoteImages ids={a.images} />
          {reflect && <ReflectBox title={reflect} noteId={a.id} onClose={() => setReflect(null)} />}
        </>
      )}
      {active && (
        <div className="note-format">
          <FormatBar onFormat={(k) => editor.current?.format(k)} />
        </div>
      )}
      {active && look && (
        <div className="note-tools">
          <div className="note-swatches">
            {PALETTE.map((p) => (
              <button
                key={p.key}
                title={p.name}
                className={`swatch-dot ${p.key === a.color ? "on" : ""}`}
                style={{ ["--dot" as string]: isDarkTheme(theme) ? p.dark : p.ink, ["--dot-soft" as string]: isDarkTheme(theme) ? p.dark : p.light }}
                onClick={() => onChange({ color: p.key })}
              />
            ))}
          </div>
          <div className="note-styles">
            {STYLES.map((s) => (
              <button
                key={s.key}
                title={s.key === a.style ? t("card.styleClear", { name: s.name }) : s.name}
                className={`style-chip ${s.key === a.style ? "on" : ""}`}
                onClick={() => onChange({ style: (s.key === a.style ? "none" : s.key) as HighlightStyle })}
              >
                <StylePreview style={s.key} color={accent} soft={isDarkTheme(theme) ? `${sw.dark}55` : sw.light} />
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="note-meta">
        <span>{fmt(a.updatedAt)}</span>
        {active && (
          <span className="note-actions">
            <button title={t("card.look")} className={look ? "on" : ""} aria-pressed={look} onClick={() => setLook((v) => !v)}>
              <Palette size={14} />
            </button>
            <button title={t("card.addTag")} onClick={() => editor.current?.startTag()}>
              <Hash size={14} />
            </button>
            <button title={t("card.addImage")} onClick={() => editor.current?.pickImage()}>
              <ImagePlus size={14} />
            </button>
            {canSwapSide && (
              <button title={t("card.swap")} onClick={onSwapSide}>
                <ArrowLeftRight size={14} />
              </button>
            )}
            <button title={t("card.delete")} className="danger" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
