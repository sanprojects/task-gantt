import { ZoomMode, Task, DateFormat } from "./types";

const MS_PER_DAY = 86400000;

// 'YYYY-MM-DD' を UTC の通日番号へ / parse to a UTC day index
export function dayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / MS_PER_DAY);
}

// 通日番号を 'YYYY-MM-DD' へ / day index back to date string
export function dayToStr(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayIndex(): number {
  return Math.floor(Date.now() / MS_PER_DAY);
}

// ISO（YYYY-MM-DD）を表示用フォーマットへ整形 / format an ISO date for display
export function formatDate(iso: string | undefined, fmt: DateFormat): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso; // 解釈できない値はそのまま表示 / pass unparseable values through
  const [, y, mo, d] = m;
  switch (fmt) {
    case "DD/MM/YYYY":
      return `${d}/${mo}/${y}`;
    case "MM/DD/YYYY":
      return `${mo}/${d}/${y}`;
    default:
      return `${y}/${mo}/${d}`;
  }
}

// ズームごとの 1 日あたりピクセル / pixels per day per zoom
// Fit はコンテナ幅から動的に算出するため、ここでは Week 相当のフォールバック
// Fit is computed from the container width elsewhere; here it falls back to the Week scale
export function pxPerDay(zoom: ZoomMode): number {
  switch (zoom) {
    case "Day":
      return 36;
    case "Week":
      return 16;
    case "Month":
      return 5;
    case "Fit":
      return 16;
  }
}

export interface DateRange {
  min: number; // 開始日（通日）/ first day index
  max: number; // 終了日（通日）/ last day index
}

// タスク群から表示範囲を決める（前後に余白）/ compute the visible range with padding
export function computeRange(tasks: Task[]): DateRange {
  const days: number[] = [];
  // 不正な日付（NaN）は範囲計算から除外して全体崩壊を防ぐ / drop NaN day indices so a bad date can't break the whole range
  const push = (s?: string) => {
    if (!s) return;
    const i = dayIndex(s);
    if (Number.isFinite(i)) days.push(i);
  };
  for (const t of tasks) {
    push(t.start);
    push(t.end);
  }
  if (days.length === 0) {
    const today = todayIndex();
    return { min: today - 7, max: today + 30 };
  }
  return { min: Math.min(...days) - 3, max: Math.max(...days) + 7 };
}

export interface Tick {
  x: number;
  label: string;
  major: boolean; // 月境界など / month boundary
}

// 上部の日付軸の目盛りを生成 / generate header ticks
export function buildTicks(range: DateRange, zoom: ZoomMode, ppd: number): Tick[] {
  const ticks: Tick[] = [];
  // 曜日略称（英語・固定）。ロケール非依存で軸に出るので日本語ハードコードを排除 / English weekday abbreviations (locale-independent axis labels)
  const wk = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const x = (day - range.min) * ppd;
    const isMonthStart = d.getUTCDate() === 1;
    if (zoom === "Day") {
      ticks.push({ x, label: `${d.getUTCDate()} ${wk[d.getUTCDay()]}`, major: isMonthStart });
    } else if (zoom === "Week") {
      if (d.getUTCDay() === 1 || isMonthStart) {
        ticks.push({ x, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, major: isMonthStart });
      }
    } else {
      if (isMonthStart) ticks.push({ x, label: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`, major: true });
    }
  }
  return ticks;
}
