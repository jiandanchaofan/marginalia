/**
 * Desktop: one key that works from any app — it brings the main window to the front with the command palette open.
 * The OS-level key is held by the global-shortcut plugin; this module keeps the one registration in step with the setting.
 */
import { useSyncExternalStore } from "react";
import { isTauri } from "../platform";

export const DEFAULT_WAKE = "Ctrl+Alt+K";
/** The id the shortcut settings use for the wake-up row. */
export const WAKE_ID = "__wake";

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

/* ---- the small wake-up window: only the palette, over whatever app is in front ---- */
export const QUICK_LABEL = "quick";
export const QUICK_WIDTH = 660;
/** Main → small window: you are about to be shown, start fresh. */
export const QUICK_SHOW = "quick-show";
/** Small window → main: run this pick (an `Act`) and come to the front. */
export const PALETTE_ACT = "palette-act";

type Win = import("@tauri-apps/api/webviewWindow").WebviewWindow;
let making: Promise<Win> | null = null;

/** Made once, hidden, when the app starts, so the key brings it up at once (one creation at a time: two calls share it). */
export function ensureQuickWindow(): Promise<Win> {
  making ??= makeQuickWindow().finally(() => (making = null));
  return making;
}

async function makeQuickWindow(): Promise<Win> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const had = await WebviewWindow.getByLabel(QUICK_LABEL);
  if (had) return had;
  const w = new WebviewWindow(QUICK_LABEL, {
    url: "index.html?quick=1",
    title: "Marginalia",
    width: QUICK_WIDTH,
    height: 120,
    visible: false,
    focus: false,
    decorations: false,
    transparent: true,
    shadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  });
  // wait until it really exists (or failed), so the next call finds it by its label
  const ok = await new Promise<boolean>((res) => {
    void w.once("tauri://created", () => res(true));
    void w.once("tauri://error", (e) => (console.warn("wake-up window failed", e), res(false)));
  });
  return ok ? w : ((await WebviewWindow.getByLabel(QUICK_LABEL)) ?? w);
}

/** What pressing the key does: the small window comes up on the screen the mouse is on; pressed again while it is up, it goes away. */
export async function wakeUp() {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { cursorPosition, monitorFromPoint, LogicalPosition } = await import("@tauri-apps/api/window");
  const w = await ensureQuickWindow();
  if ((await w.isVisible()) && (await w.isFocused())) return void (await w.hide());
  await emitTo(QUICK_LABEL, QUICK_SHOW);
  try {
    const c = await cursorPosition();
    const m = await monitorFromPoint(c.x, c.y);
    if (m) {
      const f = m.scaleFactor;
      const x = m.position.x / f + (m.size.width / f - QUICK_WIDTH) / 2;
      const y = m.position.y / f + (m.size.height / f) * 0.2;
      await w.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    }
  } catch {
    /* leave it where it was */
  }
  await w.show();
  await w.setFocus();
}
