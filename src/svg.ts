// SVG element factory plus in-bar text measurement and labeling helpers.

const SVG_NS = "http://www.w3.org/2000/svg";

// Create an SVG element with the given attributes.
export function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = activeDocument.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Measures in-bar text width via a canvas (works before attach, triggers no reflow).
// The font family is read lazily from a host element, so it reflects the active theme.
export class TextMeasurer {
  private ctx: CanvasRenderingContext2D | null = null;
  private family = "";
  constructor(private host: () => HTMLElement) {}

  width(s: string, weight: number): number {
    if (!this.ctx) this.ctx = activeDocument.createElement("canvas").getContext("2d");
    if (!this.family) this.family = getComputedStyle(this.host()).fontFamily || "sans-serif";
    const ctx = this.ctx;
    if (!ctx) return s.length * 6; // rough estimate if canvas is unavailable
    ctx.font = `${weight} 10px ${this.family}`;
    return ctx.measureText(s).width;
  }

  // Truncate the name tail with … to fit maxWidth (binary search to limit measurements).
  fitName(name: string, maxWidth: number): string {
    if (this.width(name, 400) <= maxWidth) return name;
    let lo = 0, hi = name.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(name.slice(0, mid) + "…", 400) <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? name.slice(0, lo) + "…" : "";
  }
}

// Draw the in-bar label "<days>d  <name(…)>", left-aligned; omit the name (or all of it) if too narrow.
export function drawBarLabel(
  measurer: TextMeasurer,
  parent: SVGElement,
  x: number,
  w: number,
  cy: number,
  days: number,
  name: string
): void {
  if (w < 22) return; // too small even for the duration
  const PAD = 6, GAP = 6;
  const durStr = `${days}d`;
  const durW = measurer.width(durStr, 600);
  const dur = svgEl("text", { x: x + PAD, y: cy, class: "ogantt-bar-intext is-dur" });
  dur.textContent = durStr;
  parent.appendChild(dur);
  const avail = w - PAD - durW - GAP - PAD; // width left for the name
  if (avail < 16) return; // too narrow for a name, show the duration only
  const shown = measurer.fitName(name, avail);
  if (!shown) return;
  const nm = svgEl("text", { x: x + PAD + durW + GAP, y: cy, class: "ogantt-bar-intext" });
  nm.textContent = shown;
  parent.appendChild(nm);
}

// Build an SVG path from points, lightly rounding the right-angle elbows.
export function elbowPath(pts: Array<[number, number]>, r = 4): string {
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"} ${p[0]} ${p[1]}`).join(" ");
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py) || 1;
    const d2 = Math.hypot(nx - cx, ny - cy) || 1;
    const rr = Math.min(r, d1 / 2, d2 / 2); // clamp the radius to the segment length
    const e1x = cx + ((px - cx) / d1) * rr;
    const e1y = cy + ((py - cy) / d1) * rr;
    const e2x = cx + ((nx - cx) / d2) * rr;
    const e2y = cy + ((ny - cy) / d2) * rr;
    d += ` L ${e1x} ${e1y} Q ${cx} ${cy} ${e2x} ${e2y}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}
