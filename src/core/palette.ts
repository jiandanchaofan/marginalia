import { t } from "../i18n";
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
  { key: "amber", get name() { return t("color.amber"); }, light: "#FCE38A", ink: "#C98A00", dark: "#E8B931" },
  { key: "peach", get name() { return t("color.peach"); }, light: "#FFCFB3", ink: "#D9632B", dark: "#F08A5D" },
  { key: "rose", get name() { return t("color.rose"); }, light: "#FBC4D4", ink: "#C93C6B", dark: "#E86B95" },
  { key: "lilac", get name() { return t("color.lilac"); }, light: "#DCCBFA", ink: "#7B4FD6", dark: "#A585F0" },
  { key: "sky", get name() { return t("color.sky"); }, light: "#BFDDFB", ink: "#2F78C4", dark: "#5FA3EA" },
  { key: "teal", get name() { return t("color.teal"); }, light: "#B7EBE3", ink: "#1A8C7E", dark: "#3CC2AE" },
  { key: "sage", get name() { return t("color.sage"); }, light: "#CFE8B8", ink: "#4F8A2A", dark: "#86C25A" },
  { key: "sand", get name() { return t("color.sand"); }, light: "#E8DCC6", ink: "#8A6A3C", dark: "#C2A274" },
  { key: "slate", get name() { return t("color.slate"); }, light: "#D5DAE1", ink: "#4E5A6B", dark: "#9AA6B8" },
  { key: "crimson", get name() { return t("color.crimson"); }, light: "#F7B8B0", ink: "#B8322A", dark: "#E5594F" },
];

/** Display name for any stored style, including "none" and retired ones. */
export const styleName = (key: string) => STYLES.find((s) => s.key === key)?.name ?? (key === "none" ? t("style.none") : t("style.box"));


export const swatch = (key: string): Swatch => PALETTE.find((s) => s.key === key) ?? PALETTE[0];

/** Ordered in three families: tints, lines, marks. `group` drives the small separators in the toolbar. */
export const STYLES: { key: HighlightStyle; name: string; group: "tint" | "line" | "mark" }[] = [
  { key: "highlight", get name() { return t("style.highlight"); }, group: "tint" },
  { key: "marker", get name() { return t("style.marker"); }, group: "tint" },
  { key: "underline", get name() { return t("style.underline"); }, group: "line" },
  { key: "double", get name() { return t("style.double"); }, group: "line" },
  { key: "wavy", get name() { return t("style.wavy"); }, group: "line" },
  { key: "dashed", get name() { return t("style.dashed"); }, group: "line" },
  { key: "dotted", get name() { return t("style.dotted"); }, group: "line" },
  { key: "emphasis", get name() { return t("style.emphasis"); }, group: "mark" },
  { key: "box", get name() { return t("style.box"); }, group: "mark" },
  { key: "sidebar", get name() { return t("style.sidebar"); }, group: "mark" },
  { key: "strike", get name() { return t("style.strike"); }, group: "mark" },
];


