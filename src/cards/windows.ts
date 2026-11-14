import { t } from "../i18n";
import { CARD_KINDS, DEFAULT_SIZE, MIN_SIZE, cardOn, loadGeo, saveGeo, setCardOn, type CardKind, type Geo } from "./state";

const label = (k: CardKind) => `card-${k}`;
export const CARDS_CHANGED = "reader:cards-changed";
const changed = () => window.dispatchEvent(new Event(CARDS_CHANGED));
export const cardTitle = (k: CardKind) => (k === "notes" ? t("card.notes") : t("card.todo"));

/** Where a card goes when it has no remembered place: the right edge of the main screen, notes just left of the to-do card. */
async function defaultGeo(k: CardKind): Promise<Geo> {
  const { primaryMonitor } = await import("@tauri-apps/api/window");
  const m = await primaryMonitor();
  const size = DEFAULT_SIZE[k];
  if (!m) return { x: 80, y: 80, w: size.w, h: size.h };
  const s = m.scaleFactor || 1;
  const area = (m as { workArea?: { position: { x: number; y: number }; size: { width: number; height: number } } }).workArea ?? { position: m.position, size: m.size };
  const left = area.position.x / s, top = area.position.y / s, width = area.size.width / s, height = area.size.height / s;
  const h = Math.min(size.h, Math.max(MIN_SIZE[k].h, height - 90));
  const todoX = left + width - DEFAULT_SIZE.todo.w - 24;
  const x = k === "todo" ? todoX : todoX - DEFAULT_SIZE.notes.w - 14;
  return { x, y: top + 56, w: size.w, h };
}

/** A remembered place only counts while it is still on a screen (a monitor may have been unplugged). */
async function usableGeo(k: CardKind): Promise<Geo> {
  const g = loadGeo(k);
  if (g) {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const ms = await availableMonitors().catch(() => []);
    const onScreen = ms.some((m) => {
      const s = m.scaleFactor || 1;
      const cx = (g.x + 40) * s, cy = (g.y + 20) * s;
      return cx >= m.position.x && cx < m.position.x + m.size.width && cy >= m.position.y && cy < m.position.y + m.size.height;
    });
    if (onScreen || !ms.length) return g;
  }
  return defaultGeo(k);
}

export async function openCard(k: CardKind) {
  setCardOn(k, true);
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(label(k));
  const { invoke } = await import("@tauri-apps/api/core");
  if (existing) {
    await existing.show();
    await invoke("card_prepare", { label: label(k) });
  } else {
    const g = await usableGeo(k);
    const win = new WebviewWindow(label(k), {
      url: `index.html?card=${k}`,
      title: cardTitle(k),
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      minWidth: MIN_SIZE[k].w,
      minHeight: MIN_SIZE[k].h,
      decorations: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      shadow: false,
      focus: false,
    });
    // cards sit under every other window: once the window exists, make it a tool window at the bottom of the stack
    void win.once("tauri://created", () => void invoke("card_prepare", { label: label(k) }));
    void win.once("tauri://error", (e) => console.warn("card window failed", e));
  }
  changed();
}

export async function closeCard(k: CardKind) {
  setCardOn(k, false);
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel(label(k));
  await w?.destroy();
  changed();
}

export async function toggleCard(k: CardKind) {
  if (cardOn(k)) await closeCard(k);
  else await openCard(k);
}

/** At start: bring back the cards that were open. */
export async function restoreCards() {
  for (const k of CARD_KINDS) if (cardOn(k)) await openCard(k);
}

/** Forget remembered places and sizes; open cards jump back to their default spot. */
export async function resetCards() {
  for (const k of CARD_KINDS) {
    saveGeo(k, null);
    if (cardOn(k)) {
      await closeCard(k);
      await new Promise((r) => setTimeout(r, 400)); // let the old window go before making the new one
      await openCard(k);
    }
  }
}
