/**
 * A contrasting colour for the thin solid frame around a boxed picture area, from the area's average colour:
 * the opposite hue, deep on bright pictures and soft on dark ones, plus a faint halo of the other tone.
 */
export function contrastFrame(r: number, g: number, b: number): { c: string; h: string } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  // grey / near-white / near-black pictures have no hue to oppose: use a warm tone
  const h2 = s < 0.12 ? 38 : (hue + 180) % 360;
  const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  // bright picture → a deeper, muted line; dark picture → a soft light one. Never fully saturated, so it stays calm.
  if (lum > 0.55) return { c: `hsl(${Math.round(h2)} 38% 30%)`, h: "rgba(255,255,255,0.55)" };
  return { c: `hsl(${Math.round(h2)} 55% 78%)`, h: "rgba(0,0,0,0.35)" };
}
