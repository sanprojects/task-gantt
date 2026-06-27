// Pure, framework-free routing of a wheel/trackpad gesture onto a single axis (testable, no Obsidian deps).
//
// "x" = horizontal scroll, "y" = vertical zoom.
//
// design notes:
// - the first event mixes axes, so don't trust it: accumulate a little travel, then pick the larger.
// - sums decay each event (recent motion weighted) so the decision can adapt mid-gesture.
// - even while locked, switch axes when the perpendicular clearly dominates (hysteresis); this lets a
//   horizontal swipe begun during zoom inertia cancel the zoom and scroll instead.
// - a pause longer than idleMs starts a fresh gesture (state reset).
// - a real pinch (macOS sends it as wheel + ctrlKey) always maps to zoom.

export type WheelAxis = "x" | "y";

export interface WheelGestureInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  timeStamp: number; // ms
}

export interface WheelGestureOptions {
  idleMs?: number; // gap that starts a new gesture
  commitPx?: number; // accumulated travel before the first commit
  switchRatio?: number; // how much the perpendicular must dominate to switch
  decay?: number; // per-event decay of the rolling sums
}

export class WheelGestureRouter {
  private axis: WheelAxis | null = null;
  private lastTime = 0;
  private sumX = 0;
  private sumY = 0;
  private readonly idleMs: number;
  private readonly commitPx: number;
  private readonly switchRatio: number;
  private readonly decay: number;

  constructor(opts: WheelGestureOptions = {}) {
    this.idleMs = opts.idleMs ?? 160;
    this.commitPx = opts.commitPx ?? 6;
    this.switchRatio = opts.switchRatio ?? 1.4;
    this.decay = opts.decay ?? 0.8;
  }

  // Feed an event; returns the axis to act on now, or null while still deciding
  // (the caller should preventDefault and wait for the next event).
  route(e: WheelGestureInput): WheelAxis | null {
    if (e.timeStamp - this.lastTime > this.idleMs) this.reset();
    this.lastTime = e.timeStamp;

    // a real pinch always zooms
    if (e.ctrlKey) return (this.axis = "y");

    this.sumX = this.sumX * this.decay + Math.abs(e.deltaX);
    this.sumY = this.sumY * this.decay + Math.abs(e.deltaY);

    if (this.axis == null) {
      // hold until there's enough travel to tell
      if (Math.max(this.sumX, this.sumY) < this.commitPx) return null;
      this.axis = this.sumX > this.sumY ? "x" : "y";
    } else if (this.axis === "y" && this.sumX > this.sumY * this.switchRatio) {
      this.axis = "x"; // horizontal took over: stop zooming, scroll
    } else if (this.axis === "x" && this.sumY > this.sumX * this.switchRatio) {
      this.axis = "y"; // vertical took over: stop scrolling, zoom
    }
    return this.axis;
  }

  reset(): void {
    this.axis = null;
    this.sumX = 0;
    this.sumY = 0;
  }
}
