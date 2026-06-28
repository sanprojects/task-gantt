// SVG element factory plus the in-bar label helper.

const SVG_NS = "http://www.w3.org/2000/svg";

// Create an SVG element with the given attributes.
export function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = activeDocument.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

let labelClip = 0; // unique clipPath id per label

// Draw the label "<days>d  <name>" starting inside the bar; it continues past the bar's right edge.
// Drawn twice: a normal-color base (legible on the grid background) plus a white copy clipped to the
// bar rect, so the text is white over the bar and switches to normal text color where it spills out.
export function drawBarLabel(parent: SVGElement, x: number, y: number, w: number, h: number, days: number, name: string): void {
  const text = `${days}d  ${name}`;
  const tx = x + 6, cy = y + h / 2;
  const base = svgEl("text", { x: tx, y: cy, class: "ogantt-bar-outtext" });
  base.textContent = text;
  parent.appendChild(base);
  const id = `ogantt-barclip-${labelClip++}`;
  const clip = svgEl("clipPath", { id });
  clip.appendChild(svgEl("rect", { x, y, width: w, height: h }));
  parent.appendChild(clip);
  const over = svgEl("text", { x: tx, y: cy, class: "ogantt-bar-intext", "clip-path": `url(#${id})` });
  over.textContent = text;
  parent.appendChild(over);
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
