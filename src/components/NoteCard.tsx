import { useLayoutEffect, useRef } from "react";
import { ArrowLeftRight, Hash, ImagePlus, Trash2 } from "lucide-react";
import type { Annotation, HighlightStyle } from "../core/types";
import { PALETTE, STYLES, swatch } from "../core/palette";
import type { Theme } from "../settings";
import { StylePreview } from "./StylePreview";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { NoteText } from "./NoteText";
import { FormatBar } from "./FormatBar";
import { NoteImages } from "./NoteImages";

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
  return `${sameYear ? "" : d.getFullYear() + "年"}${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function NoteCard({ a, theme, active, autoFocus, variant, side, canSwapSide, onSwapSide, style, onActivate, onChange, onDelete, onHeight, onTag, onDone }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const editor = useRef<TagTextareaHandle>(null);
  const sw = swatch(a.color);
  const accent = theme === "dark" ? sw.dark : sw.ink;

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
      style={{ ...style, ["--accent" as string]: accent, ["--tint" as string]: theme === "dark" ? `${sw.dark}22` : `${sw.light}66` }}
      onMouseDown={(e) => {
        if (!active) {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <div className="note-quote">{a.anchor.exact}</div>
      {active ? (
        <TagTextarea
          ref={editor}
          className="note-editor"
          placeholder="写下你的想法，输入 # 添加标签；Ctrl + Enter 保存"
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
          {a.note && <NoteText text={a.note} onTag={onTag} />}
          <NoteImages ids={a.images} />
        </>
      )}
      {active && (
        <div className="note-format">
          <FormatBar onFormat={(k) => editor.current?.format(k)} />
        </div>
      )}
      {active && (
        <div className="note-tools">
          <div className="note-swatches">
            {PALETTE.map((p) => (
              <button
                key={p.key}
                title={p.name}
                className={`swatch-dot ${p.key === a.color ? "on" : ""}`}
                style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
                onClick={() => onChange({ color: p.key })}
              />
            ))}
          </div>
          <div className="note-styles">
            {STYLES.map((s) => (
              <button
                key={s.key}
                title={s.key === a.style ? `${s.name}（再点一次取消）` : s.name}
                className={`style-chip ${s.key === a.style ? "on" : ""}`}
                onClick={() => onChange({ style: (s.key === a.style ? "none" : s.key) as HighlightStyle })}
              >
                <StylePreview style={s.key} color={accent} soft={theme === "dark" ? `${sw.dark}55` : sw.light} />
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="note-meta">
        <span>{fmt(a.updatedAt)}</span>
        {active && (
          <span className="note-actions">
            <button title="添加标签" onClick={() => editor.current?.startTag()}>
              <Hash size={14} />
            </button>
            <button title="添加图片（也可直接粘贴截图）" onClick={() => editor.current?.pickImage()}>
              <ImagePlus size={14} />
            </button>
            {canSwapSide && (
              <button title="移到另一侧" onClick={onSwapSide}>
                <ArrowLeftRight size={14} />
              </button>
            )}
            <button title="删除" className="danger" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
