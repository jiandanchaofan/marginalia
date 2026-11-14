import { useEffect, useRef, useState } from "react";
import "./cards.css";
import { DEFAULT_SETTINGS, bodyFont, normalizeSettings, type Settings } from "../settings";
import { isTauri, settingsStore } from "../platform";
import { resolveLang, setLang, t } from "../i18n";
import { NotesCard } from "../components/NotesCard";
import { TodoCard } from "../components/TodoCard";
import { NAV_EVENT, openInMain } from "./nav";
import { startSync } from "./sync";
import { DEFAULT_SIZE, cardOpacity, rotateSecs, saveGeo, setCardOpacity, setRotateSecs, type CardKind } from "./state";
import { cardTitle, closeCard } from "./windows";

const sizeNow = () => ({ w: window.innerWidth, h: window.innerHeight });

/** The window of one desktop card: a header to drag by, the card's content, a corner to resize by, and a right-click menu. */
export function Card({ kind }: { kind: CardKind }) {
  const [settings, setSettings] = useState<Settings>(() => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)));
  const [size, setSize] = useState(sizeNow);
  const [opacity, setOpacity] = useState(() => cardOpacity(kind));
  const [secs, setSecs] = useState(rotateSecs);
  setLang(resolveLang(settings.lang), true); // everything below re-renders with this component

  // follow the main window's theme / language / fonts (same storage, so a `storage` event arrives when it changes)
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
  useEffect(() => {
    document.title = cardTitle(kind);
  }, [kind, settings.lang]);

  useEffect(() => {
    const on = () => setSize(sizeNow());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // changes made here (ticking a to-do) reach the main window and the other card, and theirs reach us
  useEffect(() => {
    let off = () => {};
    void startSync().then((f) => (off = f));
    return () => off();
  }, []);

  // remember where the card is and how big (logical pixels), once it stops moving
  useEffect(() => {
    if (!isTauri) return;
    let timer = 0;
    let offs: (() => void)[] = [];
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const save = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(async () => {
          try {
            const [p, s, f] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
            saveGeo(kind, { x: p.x / f, y: p.y / f, w: s.width / f, h: s.height / f });
          } catch {
            /* the window is closing */
          }
        }, 400);
      };
      offs = [await win.onMoved(save), await win.onResized(save)];
    })();
    return () => {
      window.clearTimeout(timer);
      offs.forEach((f) => f());
    };
  }, [kind]);

  const root = useRef<HTMLDivElement>(null);

  const startResize = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startResizeDragging("SouthEast");
  };

  const contextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const sep = () => PredefinedMenuItem.new({ item: "Separator" });
    const items: Awaited<ReturnType<typeof MenuItem.new>>[] = [];
    items.push(await MenuItem.new({ text: t("ctx.open"), action: () => void openInMain(kind === "notes" ? { to: "notes" } : { to: "tasks-month" }) }));
    const rest: unknown[] = [await sep()];
    if (kind === "notes") {
      const opts = [0, 10, 20, 40, 60];
      rest.push(
        await Submenu.new({
          text: t("ctx.rotate"),
          items: await Promise.all(
            opts.map((n) =>
              CheckMenuItem.new({
                text: n ? t("ctx.rotateSecs", { n }) : t("ctx.rotateOff"),
                checked: secs === n,
                action: () => {
                  setRotateSecs(n);
                  setSecs(n);
                },
              }),
            ),
          ),
        }),
      );
    }
    rest.push(
      await Submenu.new({
        text: `${t("ctx.opacity")}`,
        items: await Promise.all(
          [1, 0.9, 0.8, 0.7, 0.6].map((v) =>
            CheckMenuItem.new({
              text: `${Math.round(v * 100)}%`,
              checked: Math.abs(opacity - v) < 0.03,
              action: () => {
                setCardOpacity(kind, v);
                setOpacity(v);
              },
            }),
          ),
        ),
      }),
      await MenuItem.new({ text: t("ctx.resetSize"), action: () => void win.setSize(new LogicalSize(DEFAULT_SIZE[kind].w, DEFAULT_SIZE[kind].h)) }),
      await sep(),
      await MenuItem.new({ text: t("ctx.close"), action: () => void closeCard(kind) }),
    );
    const menu = await Menu.new({ items: [...items, ...(rest as typeof items)] });
    await menu.popup();
  };

  void NAV_EVENT;
  const sub = ""; // the content shows its own details; the header only names the card
  return (
    <div className="card-root" ref={root} style={{ ["--card-alpha" as string]: String(opacity) }} onContextMenu={contextMenu}>
      <div className={`card-box card-${kind}`}>
        <div className="card-head" data-tauri-drag-region>
          <span className="card-grip" data-tauri-drag-region>
            <i /><i /><i /><i /><i /><i />
          </span>
          <span className="card-title" data-tauri-drag-region>{cardTitle(kind)}</span>
          <span className="card-sub" data-tauri-drag-region>{sub}</span>
        </div>
        <div className="card-body">{kind === "notes" ? <NotesCard w={size.w} h={size.h} secs={secs} /> : <TodoCard w={size.w} h={size.h} />}</div>
        <span className="card-resize" onMouseDown={() => void startResize()} />
      </div>
    </div>
  );
}
