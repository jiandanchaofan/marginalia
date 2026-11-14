/**
 * Pictures inside reflowing documents: plain <img>, and the SVG <image> that many EPUBs use for covers and plates.
 * A region annotation stores fractions of the *drawn* picture, so for SVG images (which letter-box inside their
 * viewport) the drawn rectangle is worked out from the picture's natural size.
 */
export const PICTURE_SELECTOR = "img, image";
const XLINK = "http://www.w3.org/1999/xlink";

export const pictureElements = (root: ParentNode): Element[] => [...root.querySelectorAll(PICTURE_SELECTOR)];

export const pictureHref = (el: Element): string | null => el.getAttribute("src") ?? el.getAttribute("href") ?? el.getAttributeNS(XLINK, "href");

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** On-screen rectangle of the drawn picture (SVG images: "meet" letter-boxing inside the element's box). */
export function pictureRect(el: Element, nat?: { w: number; h: number } | null): Rect {
  const r = el.getBoundingClientRect();
  if (el instanceof HTMLImageElement || !nat || !nat.w || !nat.h) return { left: r.left, top: r.top, width: r.width, height: r.height };
  const s = Math.min(r.width / nat.w, r.height / nat.h);
  const w = nat.w * s;
  const h = nat.h * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

export const sizeKey = (nat: { w: number; h: number } | null | undefined) => `${nat?.w ?? 0}x${nat?.h ?? 0}`;
export function parseSizeKey(key: string): { w: number; h: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m && Number(m[1]) ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
