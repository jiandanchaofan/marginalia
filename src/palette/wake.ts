/**
 * Desktop: one key that works from any app — it brings the main window to the front with the command palette open.
 * The OS-level key is held by the global-shortcut plugin; this module keeps the one registration in step with the setting.
 */
import { useSyncExternalStore } from "react";
import { isTauri } from "../platform";

export const DEFAULT_WAKE = "Ctrl+Alt+K";
/** The id the shortcut settings use for the wake-up row. */
export const WAKE_ID = "__wake";
/** The palette listens for this: detail "open" or "toggle". */
export const PALETTE_EVENT = "reader:palette";

export const wakeComboOf = (wakeKey: string | undefined) => wakeKey ?? DEFAULT_WAKE;

/**
 * The combo a key event stands for, read from the physical key (so Shift+1 stays "Shift+1", not "Shift+!").
 * Only letters, digits, F1–F12 and Space can be a wake key; null for anything else or while only modifiers are down.
 */
export function wakeEventCombo(e: KeyboardEvent): string | null {
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit[0-9]$/.test(c) ? c.slice(5) : /^F([1-9]|1[0-2])$/.test(c) ? c : c === "Space" ? "Space" : null;
  if (!key) return null;
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

/** A wake key must not take an everyday key away from other apps: two modifiers, or one modifier with an F key. */
export function wakeCheck(combo: string): "ok" | "weak" {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.length - 1;
  return mods >= 2 || (mods === 1 && /^F\d+$/.test(key)) ? "ok" : "weak";
}

/** "Ctrl+Alt+K" → what the plugin parses. */
const toAccelerator = (combo: string) => combo.replace(/^Ctrl\+/, "CommandOrControl+");

export type WakeState = "off" | "on" | "taken" | "web";
let state: WakeState = isTauri ? "off" : "web";
const subs = new Set<() => void>();
const setState = (s: WakeState) => {
  state = s;
  subs.forEach((f) => f());
};
export const useWakeState = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  );

let wanted = "";
let held = ""; // accelerator registered right now
let suspended = false;
let chain: Promise<void> = Promise.resolve();
let handler: () => void = () => {};

/** Registrations are changed one at a time, in order (each step waits for the one before). */
function sync() {
  chain = chain.then(async () => {
    if (!isTauri) return;
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    const target = wanted && !suspended ? toAccelerator(wanted) : "";
    if (held && held !== target) {
      await gs.unregister(held).catch(() => {});
      held = "";
    }
    if (!target) return setState(suspended && wanted ? state : "off");
    if (held === target) return setState("on");
    try {
      // left over from before a page reload: the plugin still holds it with a dead callback
      if (await gs.isRegistered(target)) await gs.unregister(target);
      await gs.register(target, (e) => {
        if (e.state === "Pressed") handler();
      });
      held = target;
      setState("on");
    } catch {
      setState("taken");
    }
  });
  return chain;
}

/** Use this combo ("" = none); `onWake` runs when it is pressed. */
export function applyWakeKey(combo: string, onWake: () => void) {
  handler = onWake;
  wanted = combo;
  return sync();
}

/** The settings page lets go of the key while it listens for a new one (so the OS does not swallow the keys). */
export function suspendWake(s: boolean) {
  if (suspended === s) return;
  suspended = s;
  void sync();
}

/** What pressing the key does: in front with the palette open; pressed again while already in front, the palette closes. */
export async function wakeUp() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  const inFront = (await w.isVisible()) && !(await w.isMinimized()) && (await w.isFocused());
  if (!inFront) {
    await w.show();
    await w.unminimize();
    await w.setFocus();
  }
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: inFront ? "toggle" : "open" }));
}
