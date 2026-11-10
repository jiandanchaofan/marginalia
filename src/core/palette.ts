import type { HighlightStyle } from "./types";

/**
 * Ten curated highlight colors. Each has a soft "paper" tint for light themes,
 * an ink tone for underlines/strokes, and a muted glow for the dark theme.
 */
export interface Swatch {
  key: string;
  name: string;
  light: string; // fill on light/sepia paper (drawn with multiply)
  ink: string; // strokes, card accents
  dark: string; // fill on dark paper (drawn with normal blend at low alpha)
}

export const PALETTE: Swatch[] = [
  { key: "amber", name: "琥珀", light: "#FCE38A", ink: "#C98A00", dark: "#E8B931" },
  { key: "peach", name: "蜜桃", light: "#FFCFB3", ink: "#D9632B", dark: "#F08A5D" },
  { key: "rose", name: "玫瑰", light: "#FBC4D4", ink: "#C93C6B", dark: "#E86B95" },
  { key: "lilac", name: "丁香", light: "#DCCBFA", ink: "#7B4FD6", dark: "#A585F0" },
  { key: "sky", name: "天青", light: "#BFDDFB", ink: "#2F78C4", dark: "#5FA3EA" },
  { key: "teal", name: "松石", light: "#B7EBE3", ink: "#1A8C7E", dark: "#3CC2AE" },
  { key: "sage", name: "鼠尾草", light: "#CFE8B8", ink: "#4F8A2A", dark: "#86C25A" },
  { key: "sand", name: "砂岩", light: "#E8DCC6", ink: "#8A6A3C", dark: "#C2A274" },
  { key: "slate", name: "石墨", light: "#D5DAE1", ink: "#4E5A6B", dark: "#9AA6B8" },
  { key: "crimson", name: "朱砂", light: "#F7B8B0", ink: "#B8322A", dark: "#E5594F" },
];

/** Display name for any stored style, including "none" and retired ones. */
export const styleName = (key: string) => STYLE_NAMES[key] ?? (key === "none" ? "仅笔记" : "框选");
const STYLE_NAMES: Record<string, string> = {};

export const swatch = (key: string): Swatch => PALETTE.find((s) => s.key === key) ?? PALETTE[0];

/** Ordered in three families: tints, lines, marks. `group` drives the small separators in the toolbar. */
export const STYLES: { key: HighlightStyle; name: string; group: "tint" | "line" | "mark" }[] = [
  { key: "highlight", name: "高亮", group: "tint" },
  { key: "marker", name: "马克笔", group: "tint" },
  { key: "underline", name: "下划线", group: "line" },
  { key: "double", name: "双底线", group: "line" },
  { key: "wavy", name: "波浪线", group: "line" },
  { key: "dashed", name: "虚线", group: "line" },
  { key: "dotted", name: "点线", group: "line" },
  { key: "emphasis", name: "着重号", group: "mark" },
  { key: "box", name: "框选", group: "mark" },
  { key: "sidebar", name: "侧线", group: "mark" },
  { key: "strike", name: "删除线", group: "mark" },
];

STYLES.forEach((s) => (STYLE_NAMES[s.key] = s.name));
