import { useSyncExternalStore } from "react";
import { zhHans, type Key } from "./zh-Hans";
import { zhHant } from "./zh-Hant";
import { en } from "./en";

/** UI languages. Simplified Chinese is the source language: the other dictionaries must have exactly its keys. */
export type Lang = "zh-Hans" | "zh-Hant" | "en";
export type LangPref = "auto" | Lang;

export const LANGS: { key: Lang; name: string }[] = [
  { key: "zh-Hans", name: "简体中文" },
  { key: "zh-Hant", name: "繁體中文" },
  { key: "en", name: "English" },
];

const DICTS: Record<Lang, Record<Key, string>> = { "zh-Hans": zhHans, "zh-Hant": zhHant, en };

/** The system language → one of ours: zh-TW / HK / MO / Hant → traditional, other zh → simplified, everything else → English. */
export function detectLang(tag: string | undefined = typeof navigator === "undefined" ? "" : navigator.language): Lang {
  const l = (tag || "").toLowerCase();
  if (l.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(l) ? "zh-Hant" : "zh-Hans";
  return "en";
}
export const resolveLang = (pref: LangPref | undefined): Lang => (pref && pref !== "auto" ? pref : detectLang());

let current: Lang = "zh-Hans";
const listeners = new Set<() => void>();
export const getLang = () => current;
/** Switch the language. `quiet` skips notifying subscribers (used while the App root renders: everything below re-renders anyway). */
export function setLang(l: Lang, quiet = false) {
  if (l === current) return;
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = l === "zh-Hans" ? "zh-CN" : l === "zh-Hant" ? "zh-TW" : "en";
  if (!quiet) listeners.forEach((f) => f());
}
/** Components that must re-render when the language changes (the App root does; everything below follows). */
export const useLang = () => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), getLang);

/** BCP-47 tag for Intl / localeCompare. */
export const localeOf = (l: Lang = current) => (l === "zh-Hans" ? "zh-CN" : l === "zh-Hant" ? "zh-TW" : "en");

export type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/**
 * Translate. `{name}` placeholders are filled from `vars`. When `vars.n` is given and the dictionary has
 * `key_one` / `key_other` (English plurals), the one that matches `n` is used.
 */
export function t(key: Key, vars?: Vars): string {
  const d = DICTS[current];
  if (vars && typeof vars.n === "number") {
    const plural = `${key}_${new Intl.PluralRules(localeOf()).select(vars.n)}` as Key;
    if (plural in d) return fill(d[plural], vars);
  }
  return fill(d[key] ?? zhHans[key] ?? key, vars);
}

export const fmtDate = (t_: number | Date, o: Intl.DateTimeFormatOptions = {}) => new Date(t_).toLocaleDateString(localeOf(), o);
export const fmtDateTime = (t_: number | Date, o: Intl.DateTimeFormatOptions = {}) => new Date(t_).toLocaleString(localeOf(), o);
/** Locale-aware sort (Chinese by pinyin / stroke rules of the language, English by letters). */
export const collate = (a: string, b: string) => a.localeCompare(b, localeOf());

/** The product name as shown in the UI: Chinese UIs pair 墨边 with Marginalia, English shows Marginalia only. */
export const brandName = () => (current === "en" ? "Marginalia" : current === "zh-Hant" ? "墨邊 · Marginalia" : "墨边 · Marginalia");

/** True when `v` is the translation of `key` in ANY language (search words such as colour names work in all of them). */
export const anyLang = (key: Key, v: string) => Object.values(DICTS).some((d) => d[key] === v);

/** "October" / "10月" (with the year when asked: "October 2025" / "2025年10月") for the month `m` (1–12) of year `y`. */
export const monthName = (y: number | string, m: number | string, withYear = false) => {
  if (current !== "en") return `${withYear ? `${Number(y)}年` : ""}${Number(m)}月`; // Chinese: 10月 rather than 十月
  return fmtDate(new Date(Number(y), Number(m) - 1, 1), { year: withYear ? "numeric" : undefined, month: "long" });
};

/** A day `YYYY-MM-DD` as a short label: "Nov 20" in English (with the year when asked), "11-20" in Chinese. */
export const shortDay = (iso: string, withYear = false) => {
  if (current !== "en") return withYear ? iso : iso.slice(5);
  const [y, m, d] = iso.split("-").map(Number);
  return fmtDate(new Date(y, m - 1, d), { year: withYear ? "numeric" : undefined, month: "short", day: "numeric" });
};
