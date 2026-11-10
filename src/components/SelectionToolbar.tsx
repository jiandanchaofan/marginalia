import { Copy, MessageSquarePlus } from "lucide-react";
import { PALETTE, STYLES } from "../core/palette";
import type { HighlightStyle } from "../core/types";
import type { Theme } from "../settings";
import { StylePreview } from "./StylePreview";

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
  onCopy(): void;
}

export function SelectionToolbar({ x, y, below, theme, color, style, onStyle, onPick, onNote, onCopy }: Props) {
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
            title={`${p.name}（点击即标注）`}
            className={`swatch-dot big ${p.key === color ? "on" : ""}`}
            style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
            onClick={() => onPick(p.key)}
          />
        ))}
        <span className="sel-sep" />
        <button className="sel-action" title="标注并写笔记" onClick={onNote}>
          <MessageSquarePlus size={16} />
          <span>笔记</span>
        </button>
        <button className="sel-action icon" title="复制" onClick={onCopy}>
          <Copy size={15} />
        </button>
      </div>
      <div className="sel-row styles">
        {STYLES.map((s, i) => (
          <span key={s.key} className="style-slot">
            {i > 0 && STYLES[i - 1].group !== s.group && <span className="sel-sep thin" />}
            <button title={s.key === style ? `${s.name}（再点一次取消样式）` : `${s.name}（点击即标注）`} className={`style-chip ${s.key === style ? "on" : ""}`} onClick={() => onStyle(s.key)}>
              <StylePreview style={s.key} color={theme === "dark" ? cur.dark : cur.ink} soft={theme === "dark" ? `${cur.dark}55` : cur.light} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
