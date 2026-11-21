import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, bodyFont, normalizeSettings, type Settings } from "../settings";
import { isTauri, loadLibrary, settingsStore } from "../platform";
import { resolveLang, setLang } from "../i18n";
import { registerBuiltins } from "../host/builtins";
import { setEnabled } from "../host/registry";
import type { BookRecord } from "../core/types";
import { startSync } from "../cards/sync";
import type { Actions } from "./commands";
import { Palette, type Act } from "./Palette";
import { PALETTE_ACT, QUICK_SHOW, QUICK_WIDTH } from "./wake";

const noop = () => {};
/** The wake-up window never runs a command itself: picking a row sends it to the main window (see `Act`). */
const NO_ACTIONS: Actions = { desktop: true, view: noop, settings: noop, importDocs: noop, clip: noop, toggleTheme: noop, lang: noop, card: noop, capture: noop };

/**
 * The small window the wake-up key brings up over whatever app is in front: only the palette's field and results.
 * Picking a result hands it to the main window, which then comes up and goes there.
 */
export function QuickWindow() {
  const [settings, setSettings] = useState<Settings>(() => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)));
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [round, setRound] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  setLang(resolveLang(settings.lang), true);

  // same storage as the main window: follow its theme, language, modules, shortcuts
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === "reader:settings" || e.key === null) setSettings(normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)));
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--read-font", bodyFont(settings));
  }, [settings.theme, settings.font, settings.fontEn]);
  useEffect(() => registerBuiltins(), []);
  useEffect(() => setEnabled(settings.modules ?? []), [settings.modules]);
  useEffect(() => {
    if (!isTauri) return;
    let off = noop;
    void startSync().then((f) => (off = f));
    return () => off();
  }, []);

  const hide = async () => {
    if (!isTauri) return void (document.documentElement.dataset.quickHidden = String(Date.now())); // browser test page
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  };

  useEffect(() => {
    const offs: (() => void)[] = [];
    let gone = false;
    const fresh = () => void loadLibrary().then(setBooks, noop);
    fresh();
    if (!isTauri) return;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // each time it comes up: an empty field, the shelf as it is now
      offs.push(
        await listen(QUICK_SHOW, () => {
          setRound((r) => r + 1);
          fresh();
        }),
      );
      // clicking anywhere else puts it away, like Spotlight
      offs.push(
        await getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload) document.getElementById("palette-input")?.focus();
          else void hide();
        }),
      );
      if (gone) offs.forEach((f) => f());
    })();
    return () => {
      gone = true;
      offs.forEach((f) => f());
    };
  }, []);

  // the window is exactly as tall as the sheet (the area around it would otherwise catch clicks meant for other apps)
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let last = 0;
    const ro = new ResizeObserver(async () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (!h || h === last || !isTauri) return;
      last = h;
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setSize(new LogicalSize(QUICK_WIDTH, h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const send = async (a: Act) => {
    if (!isTauri) {
      // browser test page: show what would have been sent
      ((window as unknown as { __quickActs?: Act[] }).__quickActs ??= []).push(a);
      return hide();
    }
    const { emitTo } = await import("@tauri-apps/api/event");
    await hide();
    await emitTo("main", PALETTE_ACT, a);
  };

  return (
    <div ref={root} className="quick-root">
      <Palette
        key={round}
        books={books}
        actions={NO_ACTIONS}
        onOpenBook={noop}
        onOpenNote={noop}
        onOpenTask={noop}
        onOpenBookAt={noop}
        notify={noop}
        bookSearch={settings.bookSearch !== false}
        shortcuts={settings.shortcuts}
        quick={{ onAct: (a) => void send(a), onClose: () => void hide() }}
      />
    </div>
  );
}
