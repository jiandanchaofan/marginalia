import { isDarkTheme } from "../settings";
import { BookOpen, Copy, ListChecks, MessageSquarePlus } from "lucide-react";
import { PALETTE, STYLES } from "../core/palette";
import type { HighlightStyle } from "../core/types";
import type { Theme } from "../settings";
import { StylePreview } from "./StylePreview";
import { t } from "../i18n";

interface Props {
  x: number;
  y: number;
  below: boolean;
  theme: Theme;
  color: string;
  style: HighlightStyle;
  onStyle(s: HighlightStyle): void;
  onPick(color: string): void;
  onNote(): void;
  onTodo(): void;
  onCopy(): void;
  /** Look the selected word up in a dictionary (not offered for region boxes). */
  onDict?(): void;
  /** Region boxes have no text to copy. */
  hideCopy?: boolean;
}

export function SelectionToolbar({ x, y, below, theme, color, style, onStyle, onPick, onNote, onTodo, onCopy, onDict, hideCopy }: Props) {
  const cur = PALETTE.find((p) => p.key === color) ?? PALETTE[0];
  return (
    <div
      className={`sel-toolbar ${below ? "below" : ""}`}
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.preventDefault() /* keep the text selection alive */}
    >
      <div className="sel-row">
        {PALETTE.map((p) => (
          <button
            key={p.key}
            title={t("sel.tip", { name: p.name })}
            className={`swatch-dot big ${p.key === color ? "on" : ""}`}
            style={{ ["--dot" as string]: isDarkTheme(theme) ? p.dark : p.ink, ["--dot-soft" as string]: isDarkTheme(theme) ? p.dark : p.light }}
            onClick={() => onPick(p.key)}
          />
        ))}
      </div>
      <div className="sel-row styles">
        {STYLES.map((s, i) => (
          <span key={s.key} className="style-slot">
            {i > 0 && STYLES[i - 1].group !== s.group && <span className="sel-sep thin" />}
            <button title={s.key === style ? t("sel.styleClear", { name: s.name }) : t("sel.tip", { name: s.name })} className={`style-chip ${s.key === style ? "on" : ""}`} onClick={() => onStyle(s.key)}>
              <StylePreview style={s.key} color={isDarkTheme(theme) ? cur.dark : cur.ink} soft={isDarkTheme(theme) ? `${cur.dark}55` : cur.light} />
            </button>
          </span>
        ))}
      </div>
      <div className="sel-row acts">
        <button className="sel-action" title={t("sel.note")} onClick={onNote}>
          <MessageSquarePlus size={16} />
          <span>{t("sel.noteLabel")}</span>
        </button>
        <button className="sel-action" title={t("sel.todoTip")} onClick={onTodo}>
          <ListChecks size={16} />
          <span>{t("sel.todoLabel")}</span>
        </button>
        {onDict && (
          <button className="sel-action" title={t("sel.dictTip")} onClick={onDict}>
            <BookOpen size={16} />
            <span>{t("sel.dict")}</span>
          </button>
        )}
        {!hideCopy && (
          <button className="sel-action icon" title={t("sel.copy")} onClick={onCopy}>
            <Copy size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
