import type { Box } from "./rects";
import type { HighlightStyle } from "./types";

export interface Shape {
  d: string; // SVG path
  /** fill = soft tint; ink = solid dots/marks in the ink colour; stroke = lines. */
  kind: "fill" | "ink" | "stroke";
  dash?: string;
  width?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  return `M${r1(x + r)},${r1(y)}h${r1(w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}v${r1(h - 2 * r)}a${r},${r} 0 0 1 -${r},${r}h${r1(
    -(w - 2 * r),
  )}a${r},${r} 0 0 1 -${r},-${r}v${r1(-(h - 2 * r))}a${r},${r} 0 0 1 ${r},-${r}z`;
}

/** Slightly organic marker stroke: a rounded band with gently uneven edges. */
function markerBand(x: number, y: number, w: number, h: number) {
  const j = Math.min(1.2, h * 0.08);
  return `M${r1(x + 2)},${r1(y + j)} Q${r1(x + w / 2)},${r1(y - j)} ${r1(x + w - 1)},${r1(y + j * 0.5)} L${r1(
    x + w + 1,
  )},${r1(y + h - j)} Q${r1(x + w / 2)},${r1(y + h + j)} ${r1(x)},${r1(y + h)} Z`;
}

function wave(x: number, y: number, w: number, amp: number, period: number) {
  let d = `M${r1(x)},${r1(y)}`;
  const half = period / 2;
  for (let cx = x, up = true; cx < x + w; cx += half, up = !up) {
    const nx = Math.min(cx + half, x + w);
    d += ` Q${r1((cx + nx) / 2)},${r1(y + (up ? -amp : amp))} ${r1(nx)},${r1(y)}`;
  }
  return d;
}

const dot = (cx: number, cy: number, r: number) =>
  `M${r1(cx - r)},${r1(cy)}a${r},${r} 0 1,0 ${r1(2 * r)},0a${r},${r} 0 1,0 ${r1(-2 * r)},0z`;

/**
 * Geometry for one annotation, given its merged line boxes.
 * `gutterX` is the left edge of the text column (used by the side-line style).
 */
export function shapesFor(style: HighlightStyle, boxes: Box[], fontPx: number, gutterX = 0, chars?: Box[]): Shape[] {
  const thick = Math.max(1.4, fontPx * 0.09);
  if (style === "none") return [];
  if (style === "emphasis" && chars?.length) {
    // 着重号: a dot centred under every character; all dots on a line share that line's baseline.
    let d = "";
    for (const c of chars) {
      const line = boxes.find((b) => c.y + c.h / 2 >= b.y && c.y + c.h / 2 <= b.y + b.h);
      const bottom = line ? line.y + line.h : c.y + c.h;
      const r = Math.max(1.2, c.h * 0.07);
      d += dot(c.x + c.w / 2, bottom + r * 1.2, r);
    }
    return [{ kind: "ink", d }];
  }
  if (style === "sidebar" && boxes.length) {
    const top = boxes[0].y + 2;
    const bottom = boxes[boxes.length - 1].y + boxes[boxes.length - 1].h - 2;
    const x = gutterX - Math.max(9, fontPx * 0.6);
    return [{ kind: "stroke", width: thick * 1.5, d: `M${r1(x)},${r1(top)}V${r1(bottom)}` }];
  }
  return boxes.flatMap<Shape>((b) => {
    const base = b.y + b.h - Math.max(1, b.h * 0.08);
    switch (style) {
      case "highlight":
        return [{ kind: "fill", d: roundRect(b.x - 1.5, b.y - 1, b.w + 3, b.h + 2, 3) }];
      case "marker":
        return [{ kind: "fill", d: markerBand(b.x - 1, b.y + b.h * 0.52, b.w + 2, b.h * 0.44) }];
      case "underline":
        return [{ kind: "stroke", width: thick, d: `M${r1(b.x)},${r1(base)}h${r1(b.w)}` }];
      case "double": {
        const w = Math.max(1, thick * 0.72);
        const gap = Math.max(2.6, thick * 1.9);
        return [
          { kind: "stroke", width: w, d: `M${r1(b.x)},${r1(base - gap * 0.35)}h${r1(b.w)}` },
          { kind: "stroke", width: w, d: `M${r1(b.x)},${r1(base + gap * 0.65)}h${r1(b.w)}` },
        ];
      }
      case "dashed":
        return [{ kind: "stroke", width: thick, dash: `${r1(thick * 2.4)} ${r1(thick * 2)}`, d: `M${r1(b.x)},${r1(base)}h${r1(b.w)}` }];
      case "dotted":
        return [{ kind: "stroke", width: thick * 1.15, dash: `0 ${r1(thick * 2.6)}`, d: `M${r1(b.x + thick)},${r1(base)}h${r1(b.w - thick)}` }];
      case "wavy":
        return [{ kind: "stroke", width: thick * 0.85, d: wave(b.x, base, b.w, Math.max(1.4, b.h * 0.09), Math.max(6, fontPx * 0.5)) }];
      case "emphasis": {
        // 着重号: one dot under each character (character width estimated from the line-box height).
        const charW = Math.max(6, b.h / 1.3);
        const n = Math.max(1, Math.round(b.w / charW));
        const r = Math.max(1.2, b.h * 0.07);
        const cy = b.y + b.h + r * 1.1;
        let d = "";
        for (let i = 0; i < n; i++) d += dot(b.x + ((i + 0.5) * b.w) / n, cy, r);
        return [{ kind: "ink", d }];
      }
      case "strike":
        return [{ kind: "stroke", width: thick, d: `M${r1(b.x)},${r1(b.y + b.h * 0.55)}h${r1(b.w)}` }];
      case "box":
      default: // includes the retired "circle" style
        return [{ kind: "stroke", width: Math.max(1.1, thick * 0.7), d: roundRect(b.x - 3, b.y - 2, b.w + 6, b.h + 4, 4) }];
    }
  });
}
