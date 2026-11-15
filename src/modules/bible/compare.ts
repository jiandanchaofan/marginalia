import { BUNDLED } from "./packs";

/** How other translations are shown beside the one being read. */
export type CompareMode = "off" | "bubble" | "inline" | "side";
export interface Compare {
  mode: CompareMode;
  /** The translations to show besides the main one (never the main one itself). */
  versions: string[];
}

/** Two columns need a window at least this wide (in the app's own pixels, i.e. after zooming); narrower, the other translation goes under each verse. */
export const SIDE_MIN_WIDTH = 900;

const KEY = "reader:bible:compare";
export const COMPARE_EVENT = "bible:compare-changed";

const read = (): Partial<Compare> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

export function getCompare(main: string): Compare {
  const saved = read();
  const mode: CompareMode = saved.mode === "off" || saved.mode === "inline" || saved.mode === "side" ? saved.mode : "bubble";
  const known = BUNDLED.map((b) => b.id);
  // nothing chosen yet: every other translation there is
  const chosen = Array.isArray(saved.versions) ? saved.versions : known;
  return { mode, versions: chosen.filter((v) => known.includes(v) && v !== main) };
}

export function setCompare(patch: Partial<Compare>) {
  const next = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not remembered */
  }
  window.dispatchEvent(new Event(COMPARE_EVENT));
}
