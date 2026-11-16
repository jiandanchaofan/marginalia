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

export const dictAvailable = () => isTauri || !!fake();

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

const DBL = "reader:dict-dblclick";
/** Double-clicking a word opens the card (on unless switched off). */
export const dictDblclick = (): boolean => {
  try {
    return localStorage.getItem(DBL) !== "0";
  } catch {
    return true;
  }
};
export const setDictDblclick = (on: boolean) => {
  try {
    localStorage.setItem(DBL, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
};

/** Ask the card to look a word up. */
export const lookupWord = (query: string) => window.dispatchEvent(new CustomEvent("dict:lookup", { detail: { query } }));

/** A single word or short phrase of letters, what the double-click and the palette treat as a word to look up. */
export const looksLikeWord = (s: string) => /^[A-Za-z][A-Za-z'’ -]{0,40}$/.test(s.trim());
