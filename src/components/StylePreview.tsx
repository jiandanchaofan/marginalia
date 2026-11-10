import type { HighlightStyle } from "../core/types";

/** Tiny "文A" sample rendered in a given highlight style, used on toolbar/style chips. */
export function StylePreview({ style, color, soft }: { style: HighlightStyle; color: string; soft: string }) {
  const css: React.CSSProperties = {};
  switch (style) {
    case "highlight":
      css.background = soft;
      css.borderRadius = 3;
      break;
    case "marker":
      css.background = `linear-gradient(transparent 52%, ${soft} 52%, ${soft} 96%, transparent 96%)`;
      break;
    case "underline":
      css.textDecoration = `underline 2px ${color}`;
      css.textUnderlineOffset = 3;
      break;
    case "double":
      css.textDecoration = `underline double 1.5px ${color}`;
      css.textUnderlineOffset = 2;
      break;
    case "dotted":
      css.textDecoration = `underline dotted 2px ${color}`;
      css.textUnderlineOffset = 3;
      break;
    case "emphasis":
      css.backgroundImage = `radial-gradient(circle, ${color} 1.3px, transparent 1.7px)`;
      css.backgroundSize = "0.5em 5px";
      css.backgroundPosition = "0.05em 100%";
      css.backgroundRepeat = "repeat-x";
      css.paddingBottom = 5;
      break;
    case "sidebar":
      css.borderLeft = `2.5px solid ${color}`;
      css.paddingLeft = 5;
      break;
    case "wavy":
      css.textDecoration = `underline wavy 1.5px ${color}`;
      css.textUnderlineOffset = 3;
      break;
    case "dashed":
      css.textDecoration = `underline dashed 2px ${color}`;
      css.textUnderlineOffset = 3;
      break;
    case "box":
      css.outline = `1.5px solid ${color}`;
      css.outlineOffset = 1;
      css.borderRadius = 3;
      break;
    case "strike":
      css.textDecoration = `line-through 2px ${color}`;
      break;
  }
  return (
    <span className="style-preview" style={css}>
      文A
    </span>
  );
}
