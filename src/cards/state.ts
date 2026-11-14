/** Settings of the desktop cards. Each card keeps its own keys (the card windows write them, so they never overwrite each other). */
export type CardKind = "notes" | "todo";
export const CARD_KINDS: CardKind[] = ["notes", "todo"];

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

export const cardOn = (k: CardKind) => get(`reader:card-on:${k}`) === "1";
export const setCardOn = (k: CardKind, on: boolean) => put(`reader:card-on:${k}`, on ? "1" : null);
export const anyCardOn = () => CARD_KINDS.some(cardOn);

export interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const loadGeo = (k: CardKind): Geo | null => {
  try {
    const g = JSON.parse(get(`reader:card-geo:${k}`) ?? "null");
    return g && [g.x, g.y, g.w, g.h].every((n: unknown) => typeof n === "number" && isFinite(n)) ? g : null;
  } catch {
    return null;
  }
};
export const saveGeo = (k: CardKind, g: Geo | null) => put(`reader:card-geo:${k}`, g ? JSON.stringify(g) : null);

export const cardOpacity = (k: CardKind) => {
  const n = Number(get(`reader:card-opacity:${k}`));
  return n >= 0.4 && n <= 1 ? n : 0.96;
};
export const setCardOpacity = (k: CardKind, v: number) => put(`reader:card-opacity:${k}`, String(v));

/** Seconds between two daily-review notes on the notes card (0 = stay on the one shown). */
export const rotateSecs = () => {
  const v = get("reader:card-rotate");
  const n = v === null ? 20 : Number(v);
  return [0, 10, 20, 40, 60].includes(n) ? n : 20;
};
export const setRotateSecs = (n: number) => put("reader:card-rotate", String(n));

export const MIN_SIZE: Record<CardKind, { w: number; h: number }> = { notes: { w: 210, h: 150 }, todo: { w: 250, h: 190 } };
export const DEFAULT_SIZE: Record<CardKind, { w: number; h: number }> = { notes: { w: 300, h: 340 }, todo: { w: 300, h: 560 } };
