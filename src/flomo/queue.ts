/**
 * The flomo plugin's outbox: notes created on this device wait here until the main window sends them (see flomo.ts).
 * Kept apart from flomo.ts so the note store can call `flomoQueue` without importing itself back.
 */
import type { Annotation } from "../core/types";

export const ON = "reader:flomo-on";
export const BOX = "reader:flomo-outbox";
/** The settings page listens for this (and for `storage`, when another window changed something). */
export const CHANGED = "reader:flomo";
/** Only notes made in the last few minutes count as new (an undo that brings back an old note is not a new note). */
const NEW_MS = 10 * 60_000;

export interface Item {
  id: string;
  bookId: string;
  at: number;
  tries?: number;
  next?: number;
}

export const readList = (): Item[] => {
  try {
    const v = JSON.parse(localStorage.getItem(BOX) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
};
export const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(CHANGED));
};

export const flomoOn = (): boolean => {
  try {
    return localStorage.getItem(ON) === "1";
  } catch {
    return false;
  }
};

/** The note store calls this for notes it has just created (in any window). */
export function flomoQueue(bookId: string, notes: Annotation[]) {
  if (!flomoOn() || !notes.length) return;
  const now = Date.now();
  const fresh = notes.filter((n) => now - (n.createdAt || 0) < NEW_MS);
  if (!fresh.length) return;
  const list = readList();
  const have = new Set(list.map((x) => x.id));
  const add = fresh.filter((n) => !have.has(n.id)).map((n) => ({ id: n.id, bookId, at: now }));
  if (add.length) write(BOX, [...list, ...add]);
}
