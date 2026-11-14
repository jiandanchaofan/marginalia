import { t } from "../i18n";
import { CARD_KINDS, cardOn, type CardKind } from "./state";
import { CARDS_CHANGED, cardTitle, toggleCard } from "./windows";

type TrayHandle = { setMenu(m: unknown): Promise<void> };
let tray: TrayHandle | null = null;
let showMain: () => void = () => {};

export async function showMainWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.show();
  await w.unminimize();
  await w.setFocus();
}

async function autostartState(): Promise<boolean> {
  try {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return await isEnabled();
  } catch {
    return false;
  }
}
export async function setAutostart(on: boolean) {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  if (on) await enable();
  else await disable();
  window.dispatchEvent(new Event(CARDS_CHANGED));
}
export { autostartState };

async function buildMenu() {
  const { Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { invoke } = await import("@tauri-apps/api/core");
  const open = await MenuItem.new({ id: "open", text: t("tray.open"), action: showMain });
  const cards = await Submenu.new({
    id: "cards",
    text: t("tray.cards"),
    items: await Promise.all(CARD_KINDS.map((k: CardKind) => CheckMenuItem.new({ id: `card-${k}`, text: cardTitle(k), checked: cardOn(k), action: () => void toggleCard(k) }))),
  });
  const auto = await CheckMenuItem.new({
    id: "autostart",
    text: t("tray.autostart"),
    checked: await autostartState(),
    action: async () => {
      await setAutostart(!(await autostartState()));
    },
  });
  const quit = await MenuItem.new({ id: "quit", text: t("tray.quit"), action: () => void invoke("quit_app") });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  return Menu.new({ items: [open, await sep(), cards, auto, await sep(), quit] });
}

/** The tray icon with its menu (in the current language). Called again whenever the language or a card's state changes. */
export async function rebuildTray() {
  if (!tray) return;
  await tray.setMenu(await buildMenu());
}

export async function setupTray(onShowMain: () => void) {
  if (tray) return;
  showMain = onShowMain;
  const { TrayIcon } = await import("@tauri-apps/api/tray");
  // The icon lives in the app, not in this module: if this code runs again (a hot reload while developing) the icon
  // that already exists is reused, so there is never a second one.
  const existing = await TrayIcon.getById("main");
  if (existing) {
    tray = existing as unknown as TrayHandle;
    window.addEventListener(CARDS_CHANGED, () => void rebuildTray());
    await rebuildTray();
    return;
  }
  const { defaultWindowIcon } = await import("@tauri-apps/api/app");
  const icon = await defaultWindowIcon();
  tray = (await TrayIcon.new({
    id: "main",
    icon: icon ?? undefined,
    tooltip: t("tray.tooltip"),
    menu: await buildMenu(),
    menuOnLeftClick: false,
    action: (e) => {
      if (e.type === "Click" && e.button === "Left" && e.buttonState === "Up") onShowMain();
    },
  })) as unknown as TrayHandle;
  window.addEventListener(CARDS_CHANGED, () => void rebuildTray());
}
