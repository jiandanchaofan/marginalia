import type { ModePref } from "./core/layout";
import type { HighlightStyle } from "./core/types";
import { PALETTE, STYLES } from "./core/palette";

export type Theme = "paper" | "light" | "dark";
export type FontChoice = "serif" | "kai" | "sans";
/** Latin-script font, chosen separately from the Chinese one. */
export type EnFontChoice = "same" | "literata" | "sourceserif" | "book" | "georgia" | "palatino" | "times" | "cambria" | "sans" | "humanist" | "verdana";

export interface Settings {
  theme: Theme;
  font: FontChoice;
  /** English / Latin text font (Chinese characters keep using `font`). */
  fontEn: EnFontChoice;
  /** True once the user picked an English font themselves; otherwise the built-in default always applies. */
  fontEnUser?: boolean;
  fontSize: number;
  /** Whole reading view zoom (1 = 100%): text, note cards, toolbars and PDF pages together. */
  zoom: number;
  /** Zoom of the shelf / notes / explore pages (1 = 100%). */
  libZoom: number;
  lineHeight: number;
  indent: boolean;
  layout: ModePref;
  lastColor: string;
  lastStyle: HighlightStyle;
}

/**
 * Defaults on first launch: light-yellow ("amber") highlight. Afterwards the last colour/style the
 * user chose is remembered — but a stored value that no longer exists (e.g. a retired style) falls
 * back to the default instead of silently drawing something else.
 */
export function normalizeSettings(s: Settings): Settings {
  const out = { ...s };
  out.zoom = clampZoom(out.zoom);
  out.libZoom = clampZoom(out.libZoom);
  if (!PALETTE.some((p) => p.key === out.lastColor)) out.lastColor = DEFAULT_SETTINGS.lastColor;
  if (!out.fontEnUser || !EN_FONTS.some((f) => f.key === out.fontEn)) out.fontEn = DEFAULT_SETTINGS.fontEn;
  if (out.lastStyle !== "none" && !STYLES.some((x) => x.key === out.lastStyle)) out.lastStyle = DEFAULT_SETTINGS.lastStyle;
  return out;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;
/** Keep the zoom inside its range and on the 10% grid (also repairs a missing / corrupt stored value). */
export const clampZoom = (z: unknown) => {
  const n = typeof z === "number" && isFinite(z) ? z : 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) * 10) / 10;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "paper",
  font: "serif",
  fontEn: "sourceserif",
  fontSize: 18,
  zoom: 1,
  libZoom: 1,
  lineHeight: 1.85,
  indent: true,
  layout: "auto",
  lastColor: "amber",
  lastStyle: "highlight",
};

export const FONT_STACKS: Record<FontChoice, string> = {
  serif: `"Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", Georgia, "Times New Roman", serif`,
  kai: `"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", Georgia, serif`,
  sans: `"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`,
};

/**
 * Fonts for English text that read well on screen. All are system fonts (nothing to download); each stack
 * lists close substitutes so it degrades gracefully on macOS / Windows / Linux / phones.
 */
export const EN_FONTS: { key: EnFontChoice; label: string; note: string; stack: string; builtin?: boolean }[] = [
  { key: "same", label: "跟随中文字体", note: "英文用中文字体自带的拉丁字形", stack: "" },
  {
    key: "sourceserif",
    label: "Source Serif 4",
    note: "Adobe 出品的现代衬线，清晰克制、层次分明，适合学术与长文，内置于应用，在任何设备上显示一致",
    stack: `"Source Serif 4 Variable", Georgia, "Times New Roman", serif`,
    builtin: true,
  },
  {
    key: "literata",
    label: "Literata",
    note: "为长时间阅读设计（Google Play 图书同款），字形温润、行文流畅，内置于应用，在任何设备上显示一致",
    stack: `"Literata Variable", Georgia, "Times New Roman", serif`,
    builtin: true,
  },
  {
    key: "book",
    label: "书卷体",
    note: "Charter / Iowan / Palatino，像纸质书的正文",
    stack: `"Iowan Old Style", "Charter", "Bitstream Charter", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif`,
  },
  { key: "georgia", label: "Georgia", note: "为屏幕设计的衬线体，字腔大，最经典", stack: `Georgia, "DejaVu Serif", "Times New Roman", serif` },
  { key: "palatino", label: "Palatino", note: "典雅的古典衬线，适合长文", stack: `"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", Georgia, serif` },
  { key: "cambria", label: "Cambria / Hoefler", note: "稳重的现代衬线，字距舒展", stack: `Cambria, "Hoefler Text", Constantia, Georgia, serif` },
  { key: "times", label: "Times New Roman", note: "紧凑的传统报刊体，适合小字号", stack: `"Times New Roman", Times, "Liberation Serif", serif` },
  { key: "sans", label: "无衬线（Inter / 系统）", note: "清爽现代，适合技术类文章", stack: `Inter, "Segoe UI", "SF Pro Text", "Helvetica Neue", Arial, sans-serif` },
  { key: "humanist", label: "Calibri / Candara", note: "圆润的人文无衬线，亲切", stack: `Calibri, Candara, "Gill Sans", "Segoe UI", sans-serif` },
  { key: "verdana", label: "Verdana", note: "字形宽大、辨识度极高，长时间看更不累", stack: `Verdana, "DejaVu Sans", Geneva, sans-serif` },
];

/** The reading font stack: the English font first (CJK characters fall through to the Chinese font). */
export function bodyFont(s: Pick<Settings, "font" | "fontEn">): string {
  const en = EN_FONTS.find((f) => f.key === s.fontEn)?.stack;
  return en ? `${en}, ${FONT_STACKS[s.font]}` : FONT_STACKS[s.font];
}
