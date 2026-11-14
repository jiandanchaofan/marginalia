/** Keyboard shortcuts for commands. Only what the user changed is stored (a "" value means "no shortcut"). */

export const DEFAULT_KEYS: Record<string, string> = {
  palette: "Ctrl+K",
  "new-note": "Ctrl+N",
  "new-task": "Ctrl+Shift+N",
  import: "Ctrl+O",
  "page-notes": "Alt+1",
  "page-shelf": "Alt+2",
  "page-tasks": "Alt+3",
  "page-feeds": "Alt+4",
  "hub-review": "Alt+R",
  "hub-topics": "Alt+T",
  "list-today": "Alt+D",
  settings: "Ctrl+,",
  theme: "Ctrl+Shift+D",
};

/** Rows the settings page always lists (the rest are added by hand). */
export const LISTED_IDS = [...Object.keys(DEFAULT_KEYS), "card-notes"];
/** The palette's own key can be changed but not removed. */
export const PALETTE_ID = "palette";

export type Overrides = Record<string, string>;

export const comboOf = (id: string, over?: Overrides): string => (over && id in over ? over[id] : DEFAULT_KEYS[id] ?? "");

/** Every id that has a combo right now. */
export function assigned(over?: Overrides): [string, string][] {
  const ids = new Set([...Object.keys(DEFAULT_KEYS), ...Object.keys(over ?? {})]);
  return [...ids].map((id) => [id, comboOf(id, over)] as [string, string]).filter(([, c]) => c);
}
export const ownerOf = (combo: string, over?: Overrides, except?: string) => assigned(over).find(([id, c]) => c === combo && id !== except)?.[0];

const NAMES: Record<string, string> = { " ": "Space", Escape: "Esc" };
/** The combo a key event stands for, e.g. `Ctrl+Shift+N`; null while only modifier keys are down. */
export function eventCombo(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "Dead", "Process"].includes(e.key)) return null;
  if (e.getModifierState?.("AltGraph")) return null;
  const key = NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

const RESERVED = new Set([
  "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+A", "Ctrl+F", "Ctrl+G", "Ctrl+P", "Ctrl+S",
  "Ctrl+Shift+Z", "Ctrl+Shift+V", "Ctrl+=", "Ctrl++", "Ctrl+-", "Ctrl+0", "Ctrl+Enter", "Ctrl+Tab", "Ctrl+W",
  "Alt+F4", "Alt+Tab", "Alt+Enter", "Ctrl+Shift+Esc",
]);
export type Check = "ok" | "need-modifier" | "reserved";
export function check(combo: string): Check {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const hasMod = parts.length > 1;
  if (!hasMod && !/^F([1-9]|1[0-2])$/.test(key)) return "need-modifier";
  if (["Esc", "Tab", "Enter", "Backspace", "Delete"].includes(key) && parts.length === 1) return "reserved";
  if (RESERVED.has(combo) || /^F(5|11|12)$/.test(combo)) return "reserved";
  return "ok";
}

/** Chips for showing a combo. */
export const chips = (combo: string) => combo.split(/\+(?=.)/);

let paused = false;
/** The settings page pauses the shortcuts while it listens for a new one. */
export const pauseShortcuts = (p: boolean) => void (paused = p);
export const shortcutsPaused = () => paused;
