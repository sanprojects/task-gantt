// ホイール／トラックパッドのジェスチャを 1 軸に振り分ける純ロジック（Obsidian 非依存・テスト可能）。
// Pure, framework-free routing of a wheel/trackpad gesture onto a single axis (testable, no Obsidian deps).
//
// "x" = 横スクロール / horizontal scroll, "y" = 縦ズーム / vertical zoom.
//
// 設計のポイント / design notes:
// - 最初の1イベントは縦横が混ざりやすいので信用しない。少し動きを貯めてから「大きい方」で確定。
//   the first event mixes axes, so don't trust it: accumulate a little travel, then pick the larger.
// - 累積は毎イベント減衰させる（直近の動きを重く見る）＝ジェスチャ途中でも追従できる。
//   sums decay each event (recent motion weighted) so the decision can adapt mid-gesture.
// - ロック中でも、垂直方向が現在の軸を明確に上回ったら軸を切り替える（ヒステリシス）。
//   これで「ズームの慣性が続く間に横スクロールを始める」と、ズームを止めてスクロールへ移れる。
//   even while locked, switch axes when the perpendicular clearly dominates (hysteresis); this lets a
//   horizontal swipe begun during zoom inertia cancel the zoom and scroll instead.
// - 一定時間入力が途切れたら新しいジェスチャ＝状態リセット。
//   a pause longer than idleMs starts a fresh gesture (state reset).
// - 本物のピンチ（macOS は wheel + ctrlKey で送る）は方向によらず常にズーム。
//   a real pinch (macOS sends it as wheel + ctrlKey) always maps to zoom.

export type WheelAxis = "x" | "y";

export interface WheelGestureInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  timeStamp: number; // ms
}

export interface WheelGestureOptions {
  idleMs?: number; // この時間入力が空けば新ジェスチャ / gap that starts a new gesture
  commitPx?: number; // 軸を初確定するまでに必要な累積移動量 / accumulated travel before the first commit
  switchRatio?: number; // 軸切替に必要な、垂直方向の優勢度 / how much the perpendicular must dominate to switch
  decay?: number; // 毎イベントの累積減衰 (0..1) / per-event decay of the rolling sums
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

  // イベントを食わせて、今このイベントで効かせるべき軸を返す。
  // まだ判定できないときは null（呼び出し側は preventDefault して待つ）。
  // Feed an event; returns the axis to act on now, or null while still deciding
  // (the caller should preventDefault and wait for the next event).
  route(e: WheelGestureInput): WheelAxis | null {
    if (e.timeStamp - this.lastTime > this.idleMs) this.reset();
    this.lastTime = e.timeStamp;

    // 本物のピンチは常にズーム / a real pinch always zooms
    if (e.ctrlKey) return (this.axis = "y");

    this.sumX = this.sumX * this.decay + Math.abs(e.deltaX);
    this.sumY = this.sumY * this.decay + Math.abs(e.deltaY);

    if (this.axis == null) {
      // 十分動くまで判定保留 / hold until there's enough travel to tell
      if (Math.max(this.sumX, this.sumY) < this.commitPx) return null;
      this.axis = this.sumX > this.sumY ? "x" : "y";
    } else if (this.axis === "y" && this.sumX > this.sumY * this.switchRatio) {
      this.axis = "x"; // 横が優勢に＝ズームを止めてスクロール / horizontal took over: stop zooming, scroll
    } else if (this.axis === "x" && this.sumY > this.sumX * this.switchRatio) {
      this.axis = "y"; // 縦が優勢に＝スクロールを止めてズーム / vertical took over: stop scrolling, zoom
    }
    return this.axis;
  }

  reset(): void {
    this.axis = null;
    this.sumX = 0;
    this.sumY = 0;
  }
}
