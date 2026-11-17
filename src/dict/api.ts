/**
 * The dictionaries (MDict files the person added) and looking words up. Desktop: Rust commands (src-tauri/src/dict.rs).
 * A plain browser has no dictionaries; tests can put a fake in `window.__fakeDict`.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";

export interface DictInfo {
  id: string;
  title: string;
  path: string;
  enabled: boolean;
  entries: number;
  resourceFiles: number;
  error: string | null;
}
export interface DictEntry {
  dictId: string;
  title: string;
  headword: string;
  body: string;
  scripts: boolean;
}
export interface DictFound {
  query: string;
  /** The form that was found when it is not the one asked for ("running" -> "run"). */
  resolved?: string | null;
  entries: DictEntry[];
  suggestions: string[];
  problems: string[];
}

interface Fake {
  list(): Promise<DictInfo[]>;
  add(path: string): Promise<DictInfo[]>;
  remove(id: string): Promise<DictInfo[]>;
  setEnabled(id: string, on: boolean): Promise<DictInfo[]>;
  shift(id: string, by: number): Promise<DictInfo[]>;
  lookup(q: string): Promise<DictFound>;
  resource(id: string, name: string): Promise<[string, string] | null>;
}
const fake = (): Fake | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { __fakeDict?: Fake }).__fakeDict);
const none: DictFound = { query: "", entries: [], suggestions: [], problems: [] };

const ON = "reader:dict-on";
/** The dictionary feature is a plugin: off until switched on in Settings → Plugins. */
export const dictOn = (): boolean => {
  try {
    return localStorage.getItem(ON) === "1";
  } catch {
    return false;
  }
};
export const setDictOn = (on: boolean) => {
  try {
    localStorage.setItem(ON, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
};
export const dictAvailable = () => dictOn() && (isTauri || !!fake());

export const dictApi = {
  list: async (): Promise<DictInfo[]> => (isTauri ? invoke("dict_list") : (fake()?.list() ?? [])),
  add: async (path: string): Promise<DictInfo[]> => (isTauri ? invoke("dict_add", { path }) : (fake()?.add(path) ?? [])),
  remove: async (id: string): Promise<DictInfo[]> => (isTauri ? invoke("dict_remove", { id }) : (fake()?.remove(id) ?? [])),
  setEnabled: async (id: string, on: boolean): Promise<DictInfo[]> => (isTauri ? invoke("dict_set_enabled", { id, on }) : (fake()?.setEnabled(id, on) ?? [])),
  shift: async (id: string, by: number): Promise<DictInfo[]> => (isTauri ? invoke("dict_shift", { id, by }) : (fake()?.shift(id, by) ?? [])),
  lookup: async (query: string): Promise<DictFound> => (isTauri ? invoke("dict_lookup", { query }) : ((await fake()?.lookup(query)) ?? { ...none, query })),
  /** A file of a dictionary (a sound, a picture) as [mime type, base64]. */
  resource: async (id: string, name: string): Promise<[string, string] | null> => (isTauri ? invoke("dict_resource", { id, name }) : ((await fake()?.resource(id, name)) ?? null)),
};

/** Pick a dictionary file: native dialog on the desktop, the fake's own choice in tests. */
export async function pickDictionary(): Promise<string | null> {
  if (!isTauri) return fake() ? "fake.mdx" : null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters: [{ name: "MDict", extensions: ["mdx"] }] });
  return typeof res === "string" ? res : null;
}

/** What the card can do with the word besides showing it: save it as a note where the person selected it. */
export interface LookupContext {
  excerpt?: (note: string) => void;
}

/** Ask the card to look a word up. */
export const lookupWord = (query: string, ctx?: LookupContext) => window.dispatchEvent(new CustomEvent("dict:lookup", { detail: { query, ...ctx } }));

/** A single word or short phrase of letters, or a short stretch of Chinese: what the palette treats as something to look up. */
export const looksLikeWord = (s: string) => {
  const t = s.trim();
  return /^[A-Za-z][A-Za-z'\u2019 -]{0,40}$/.test(t) || /^[\u3400-\u9fff]{1,12}$/.test(t);
};

const HISTORY = "reader:dict-history";
const HISTORY_MAX = 30;
/** The words looked up lately (newest first). */
export const lookupHistory = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
};
export const rememberLookup = (word: string): string[] => {
  const list = [word, ...lookupHistory().filter((w) => w !== word)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  return list;
};
export const clearLookupHistory = () => {
  try {
    localStorage.removeItem(HISTORY);
  } catch {
    /* storage unavailable */
  }
};

/** A short plain-text definition from an entry's HTML (for the note): what comes after the headword, cut to a sentence or two. */
export function shortDefinition(html: string, headword: string, max = 140): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style,script,head,audio,img").forEach((e) => e.remove());
  let text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (headword && text.toLowerCase().startsWith(headword.toLowerCase())) text = text.slice(headword.length).trim();
  return text.length > max ? `${text.slice(0, max).trim()}\u2026` : text;
}
