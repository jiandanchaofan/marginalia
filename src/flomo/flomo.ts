/**
 * The flomo plugin (off by default): every note written on this device is also sent to the user's flomo, a little later.
 *
 * - When a note is created here it goes into an outbox (localStorage, shared by the main window, the cards and the
 *   wake-up window, which all create notes). Notes that arrive from another device by cloud sync never do: that device sends them.
 * - The main window empties the outbox at its own pace: a note is sent once it has not been edited for a few minutes
 *   (so a note still being written goes over in its final form), one at a time, with a pause between.
 * - No connection or flomo busy: try again later, waiting longer each time. flomo refuses (wrong address, no PRO): stop and
 *   say so in the plugin's settings until the address is changed or "retry" is pressed.
 * - flomo's API takes text only, so pictures stay behind (the memo says how many there were).
 * The API address is a secret and lives in the system credential store (src-tauri/src/flomo.rs), not here.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import { FREE_BOOK, type BookRecord } from "../core/types";
import { notesStore, type NoteHit } from "../notes/store";
import { docLabel } from "../host/label";
import { t } from "../i18n";
import { BOX, CHANGED, ON, flomoOn, readList, write } from "./queue";

const OPTS = "reader:flomo-opts";
const STAT = "reader:flomo-status";
/** A note goes over once it has been left alone this long. */
export const SETTLE_MS = 3 * 60_000;
const TICK_MS = 60_000;
const GAP_MS = 1500;
/** flomo's limit for one memo. */
const MAX_LEN = 5000;

export interface FlomoOpts {
  /** Also send highlights that have no words of the user's own (default: only notes with text). */
  highlights: boolean;
  /** A tag added to every memo (without #); "" = none. */
  tag: string;
}
export interface FlomoStatus {
  sent: number;
  lastAt?: number;
  /** flomo refused (sending stops until fixed) or the last try failed (it will try again). */
  error?: string;
  stopped?: boolean;
}

const read = <T,>(key: string, def: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...def, ...JSON.parse(v) } : def;
  } catch {
    return def;
  }
};

export { CHANGED, flomoOn };
export function setFlomoOn(on: boolean) {
  try {
    localStorage.setItem(ON, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  // switched off: what was still waiting is not sent later either
  if (!on) write(BOX, []);
  else window.dispatchEvent(new Event(CHANGED));
}
export const flomoOpts = (): FlomoOpts => read<FlomoOpts>(OPTS, { highlights: false, tag: "" });
export const setFlomoOpts = (p: Partial<FlomoOpts>) => write(OPTS, { ...flomoOpts(), ...p });
export const flomoStatus = (): FlomoStatus => read<FlomoStatus>(STAT, { sent: 0 });
const setStatus = (p: Partial<FlomoStatus>) => write(STAT, { ...flomoStatus(), ...p });
export const outboxSize = () => readList().length;

/* ---------- the Rust side (a plain browser has none; tests can put a fake in window.__fakeFlomo) ---------- */

export interface FlomoState {
  configured: boolean;
  hint: string | null;
}
interface Fake {
  state(): Promise<FlomoState>;
  setApi(url: string): Promise<FlomoState>;
  clearApi(): Promise<FlomoState>;
  send(content: string): Promise<void>;
}
const fake = (): Fake | undefined => (window as unknown as { __fakeFlomo?: Fake }).__fakeFlomo;
export const flomoAvailable = () => isTauri || !!fake();
export const flomoApi = {
  state: (): Promise<FlomoState> => (isTauri ? invoke("flomo_state") : fake()?.state() ?? Promise.resolve({ configured: false, hint: null })),
  setApi: (url: string): Promise<FlomoState> => (isTauri ? invoke("flomo_set_api", { url }) : fake()?.setApi(url) ?? Promise.reject(t("flomo.desktopOnly"))),
  clearApi: (): Promise<FlomoState> => (isTauri ? invoke("flomo_clear_api") : fake()?.clearApi() ?? Promise.resolve({ configured: false, hint: null })),
  send: (content: string): Promise<void> => (isTauri ? invoke("flomo_send", { content }) : fake()?.send(content) ?? Promise.reject("api:" + t("flomo.desktopOnly"))),
};

/* ---------- what a memo says ---------- */

/** The memo for a note, or null when there is nothing to send (a bare highlight, unless those are wanted). */
export function memoText(hit: NoteHit, book: BookRecord | undefined, opts: FlomoOpts): string | null {
  const n = hit.note;
  const own = n.note.trim();
  const quote = n.anchor?.exact?.trim() ?? "";
  if (!own && (!quote || !opts.highlights)) return null;
  const parts: string[] = [];
  if (own) parts.push(own);
  if (hit.bookId !== FREE_BOOK) {
    if (quote) parts.push(`「${quote}」`);
    // the book's title; a module's text (no file on the shelf) by its module and place; a removed book: nothing
    const src = book?.title ? `《${book.title}》` : n.sourceModule ? docLabel(undefined, n) : "";
    if (src) parts.push(`—— ${src}`);
  }
  const pics = (n.images?.length ?? 0) + (n.anchor?.thumb ? 1 : 0);
  if (pics) parts.push(t("flomo.pics", { n: pics }));
  const tag = opts.tag.trim().replace(/^#+/, "");
  if (tag && !new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(own)) parts.push(`#${tag}`);
  let text = parts.join("\n\n");
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN - 1) + "…";
  return text;
}

/* ---------- out of the outbox (main window only) ---------- */

let running = false;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const backoff = (tries: number) => Math.min(60, 2 ** Math.min(tries, 6)) * 60_000;
const drop = (id: string) => write(BOX, readList().filter((x) => x.id !== id));

/** Send what is due. `now` = also the notes that have not settled yet (the "send now" button). */
export async function flushFlomo(books: () => BookRecord[], opts: { now?: boolean } = {}) {
  if (running || !flomoOn() || !flomoAvailable()) return;
  if (flomoStatus().stopped && !opts.now) return;
  running = true;
  try {
    if (opts.now) setStatus({ stopped: false, error: undefined });
    for (const item of readList()) {
      if (!flomoOn()) break;
      const now = Date.now();
      if (!opts.now && (item.next ?? 0) > now) continue; // waiting after a failed try
      const [hit] = await notesStore.byIds([item.id]);
      if (!hit) {
        drop(item.id); // deleted before it went over
        continue;
      }
      if (!opts.now && now - hit.note.updatedAt < SETTLE_MS) continue; // still being written
      const text = memoText(hit, books().find((b) => b.id === hit.bookId), flomoOpts());
      if (!text) {
        drop(item.id);
        continue;
      }
      try {
        await flomoApi.send(text);
        drop(item.id);
        setStatus({ sent: flomoStatus().sent + 1, lastAt: Date.now(), error: undefined });
      } catch (e) {
        const msg = String(e);
        if (msg.startsWith("net:")) {
          const tries = (item.tries ?? 0) + 1;
          write(BOX, readList().map((x) => (x.id === item.id ? { ...x, tries, next: Date.now() + backoff(tries) } : x)));
          setStatus({ error: msg.slice(4), stopped: false });
        } else setStatus({ error: msg.replace(/^api:/, ""), stopped: true });
        break; // try the rest next time
      }
      await sleep(GAP_MS);
    }
  } finally {
    running = false;
  }
}

/** Main window: empty the outbox now and then, and when the connection comes back. */
export function startFlomo(books: () => BookRecord[]) {
  if (!flomoAvailable()) return () => {};
  const go = () => void flushFlomo(books);
  const first = window.setTimeout(go, 15_000);
  const timer = window.setInterval(go, TICK_MS);
  window.addEventListener("online", go);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(timer);
    window.removeEventListener("online", go);
  };
}

/** A memo to check the address works (the settings' button). */
export const sendTest = () => flomoApi.send(t("flomo.testMemo"));
/** After the address was changed or "retry" pressed: sending may go on. */
export const clearStop = () => setStatus({ stopped: false, error: undefined });
