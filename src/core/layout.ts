/**
 * Responsive margin layout.
 * The mode is derived from the *available width* (not the device type), so phones in landscape,
 * unfolded foldables, split-screen windows and desktops all fall out of the same rule.
 */

export type MarginMode = "dual" | "single" | "compact";
export type ModePref = "auto" | MarginMode | "immersive";

export interface StageLayout {
  mode: MarginMode;
  immersive: boolean;
  content: number;
  margin: number;
  gap: number;
  pad: number;
  total: number;
}

const GAP = 30;
const MARGIN_MIN = 190;
const MARGIN_IDEAL = 300;

/** Narrowest window (CSS px) at which a mode still fits — shown to the user so they know what to change. */
export function minStageWidth(mode: "dual" | "single", preferredContent: number, fontPx: number): number {
  const contentMin = Math.min(preferredContent, Math.max(440, fontPx * 30));
  const n = mode === "dual" ? 2 : 1;
  return Math.ceil(contentMin + n * (MARGIN_MIN + GAP) + 2 * 40);
}

export function computeStage(available: number, preferredContent: number, fontPx: number, pref: ModePref): StageLayout {
  // ~30 CJK characters per line is the narrowest comfortable measure.
  const contentMin = Math.min(preferredContent, Math.max(440, fontPx * 30));
  const pad = available < 600 ? 16 : 40;
  const fits = {
    dual: available >= contentMin + 2 * (MARGIN_MIN + GAP) + 2 * pad,
    single: available >= contentMin + MARGIN_MIN + GAP + 2 * pad,
  };
  let mode: MarginMode =
    pref === "dual" || pref === "single" || pref === "compact"
      ? pref
      : fits.dual
        ? "dual"
        : fits.single
          ? "single"
          : "compact";
  // A forced mode still has to fit physically.
  if (mode === "dual" && !fits.dual) mode = fits.single ? "single" : "compact";
  if (mode === "single" && !fits.single) mode = "compact";
  const immersive = pref === "immersive";

  const inner = available - 2 * pad;
  if (mode === "compact" || immersive) {
    const content = Math.min(preferredContent, inner - (immersive ? 0 : 18));
    return { mode, immersive, content, margin: 0, gap: 0, pad, total: content };
  }
  const n = mode === "dual" ? 2 : 1;
  // Give the text its preferred width first, then let margins grow up to their ideal.
  let content = Math.min(preferredContent, inner - n * (MARGIN_MIN + GAP));
  let margin = Math.min(MARGIN_IDEAL, (inner - content) / n - GAP);
  // Extra space beyond ideal margins is left as outer whitespace: the stage is centred, the measure stays.
  content = Math.max(contentMin, content);
  margin = Math.max(MARGIN_MIN, margin);
  return { mode, immersive, content, margin, gap: GAP, pad, total: content + n * (margin + GAP) };
}

export interface CardInput {
  id: string;
  ideal: number; // desired top (px, stage coordinates)
  height: number;
}

/**
 * Place cards as close as possible to their anchor line without overlapping.
 * The active card is pinned to its ideal position; neighbours are pushed away from it.
 */
export function layoutCards(cards: CardInput[], spacing: number, activeId?: string | null): Map<string, number> {
  const sorted = [...cards].sort((a, b) => a.ideal - b.ideal);
  const pos = new Map<string, number>();
  const ai = activeId ? sorted.findIndex((c) => c.id === activeId) : -1;

  if (ai < 0) {
    let cursor = -Infinity;
    for (const c of sorted) {
      const top = Math.max(c.ideal, cursor);
      pos.set(c.id, top);
      cursor = top + c.height + spacing;
    }
    return pos;
  }

  const active = sorted[ai];
  pos.set(active.id, active.ideal);
  // Downwards from the active card.
  let cursor = active.ideal + active.height + spacing;
  for (let i = ai + 1; i < sorted.length; i++) {
    const top = Math.max(sorted[i].ideal, cursor);
    pos.set(sorted[i].id, top);
    cursor = top + sorted[i].height + spacing;
  }
  // Upwards from the active card.
  let ceiling = active.ideal - spacing;
  for (let i = ai - 1; i >= 0; i--) {
    const top = Math.min(sorted[i].ideal, ceiling - sorted[i].height);
    pos.set(sorted[i].id, top);
    ceiling = top - spacing;
  }
  return pos;
}
