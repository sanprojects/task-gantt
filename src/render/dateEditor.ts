import { Menu, setIcon, moment } from "obsidian";
import { Task, Row } from "../types";
import { ColumnId } from "../viewConstants";
import { formatDate, dayToStr, todayIndex, pad2 } from "../timeline";
import { writeField, writeDateRange } from "../model";
import { paintTagChip } from "../color";
import { t as tr } from "../i18n";
import { openPopover } from "../dom/popover";
import { ViewCtx } from "./context";

// Inline editing of table cells: start/end date cells (calendar popup), the status cell
// (status menu), and the tags cell. Entry point is renderCell(ctx, td, row, id).
// fill a non-name cell by column id
export function renderCell(ctx: ViewCtx, td: HTMLElement, row: Row, id: ColumnId): void {
  const t = row.task!;
  const fmt = ctx.plugin.settings.dateFormat;
  // when rolled up, a parent's Start/Due cells show the aggregated span too (matches the bar; not editable)
  const rolled = ctx.rollup && row.span ? row.span : null;
  switch (id) {
    case "start":
      if (rolled) {
        td.setText(formatDate(rolled.start, fmt));
      } else if (t.milestone) {
        // diamond marker; no start to edit
        td.setText("◆");
        td.addClass("ogantt-td-ms");
      } else {
        // append the time of day when set
        td.setText(formatDate(t.start, fmt) + (t.startTime ? ` ${t.startTime}` : ""));
        makeDateCell(ctx, td, t, "start");
      }
      break;
    case "end":
      if (rolled) {
        td.setText(formatDate(rolled.end, fmt));
      } else {
        td.setText(formatDate(t.end, fmt) + (t.endTime ? ` ${t.endTime}` : ""));
        makeDateCell(ctx, td, t, "end");
      }
      break;
    case "assignee":
      td.setText(t.assignee ?? "");
      break;
    case "status": {
      td.addClass("ogantt-td-status"); // vertically center the dot + label
      const s = ctx.plugin.settings.statuses.find((x) => x.id === t.status);
      if (s) {
        const dot = td.createSpan({ cls: "ogantt-status-dot" });
        dot.style.background = s.color;
        td.createSpan({ text: s.label });
      } else {
        // faint placeholder so empty cells stay clickable
        td.createSpan({ cls: "ogantt-status-empty", text: "—" });
      }
      makeStatusCell(ctx, td, t);
      break;
    }
    case "tags": {
      // tags as chips (multi-valued)
      td.addClass("ogantt-td-tags");
      for (const tag of t.tags) {
        const chip = td.createSpan({ cls: "ogantt-tag-chip", text: tag });
        paintTagChip(ctx.plugin.settings, chip, tag);
        // right-click a tag chip to change its color
        chip.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctx.openColorMenu(e, "tag", tag); });
      }
      break;
    }
    case "name":
      break; // handled by the caller
  }
}

// make a table date cell editable via double-click
function makeDateCell(ctx: ViewCtx, cell: HTMLElement, t: Task, which: "start" | "end"): void {
  cell.addClass("ogantt-td-editable");
  cell.setAttr("aria-label", tr().pickDate);
  // a single click here edits dates, not the row's open-note click
  cell.addEventListener("click", (e) => e.stopPropagation());
  cell.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openCellDatePicker(ctx, cell, t, which);
  });
}

// make a table status cell editable via single click
function makeStatusCell(ctx: ViewCtx, cell: HTMLElement, t: Task): void {
  cell.addClass("ogantt-td-editable");
  cell.setAttr("aria-label", tr().fieldStatus);
  // a click here picks a status, not the row's open-note click
  cell.addEventListener("click", (e) => {
    e.stopPropagation();
    openStatusMenu(ctx, cell, t);
  });
}

// pop a status picker under the cell and write through
function openStatusMenu(ctx: ViewCtx, anchor: HTMLElement, t: Task): void {
  const k = ctx.plugin.settings.keys;
  const choose = async (id: string | undefined): Promise<void> => {
    if ((t.status ?? "") === (id ?? "")) return; // no change
    await ctx.pushUndo(`${t.name} — ${tr().fieldStatus}`); // undoable
    await writeField(ctx.app, t.path, k.status, id);
    await ctx.refresh();
  };
  const m = new Menu();
  // unset (clear)
  m.addItem((i) => i.setTitle("—").setChecked(t.status == null).onClick(() => void choose(undefined)));
  for (const s of ctx.plugin.settings.statuses) {
    m.addItem((i) => i.setTitle(s.label).setChecked(s.id === t.status).onClick(() => void choose(s.id)));
  }
  const r = anchor.getBoundingClientRect();
  m.showAtPosition({ x: r.left, y: r.bottom + 4 });
}

// open the range calendar from a table cell
function openCellDatePicker(ctx: ViewCtx, anchor: HTMLElement, t: Task, which: "start" | "end"): void {
  const state = { start: t.start ?? "", end: t.end ?? "" };
  const save = async (): Promise<void> => {
    // "start only" isn't valid: fill end = start
    if (state.start && !state.end) state.end = state.start;
    // keep the existing time of day across the date change (clamp if inverted on the same day)
    const ts = t.startTime;
    let te = t.endTime;
    if (state.start && state.start === state.end && ts && te && te < ts) te = ts;
    await ctx.pushUndo(tr().undoReschedule(t.name)); // undoable
    await writeDateRange(ctx.app, ctx.plugin.settings, t.path, state.start, ts, state.end, te);
    await ctx.refresh();
  };
  openRangePicker(ctx, anchor, state, which, save);
}

// range calendar: pick start & end in one popup; month nav ← →, theme-aware
function openRangePicker(
  ctx: ViewCtx,
  anchor: HTMLElement,
  state: { start: string; end: string },
  active: "start" | "end",
  save: () => void | Promise<void>
): void {
  openPopover({ cls: "ogantt-cal", anchor, flip: true }, (cal) => {
    const todayStr = dayToStr(todayIndex());
    const base = state[active] || state.start || state.end || todayStr;
    let y = parseInt(base.slice(0, 4), 10);
    let m = parseInt(base.slice(5, 7), 10); // 1-based month
    let act = active; // endpoint the next click sets
    const wk = moment.weekdaysMin(); // localized minimal weekday names (Sunday-first)
    let mode: "day" | "year" = "day"; // day view or year (12-month) view
    const months = moment.monthsShort(); // localized short month names

    // Set one endpoint, then alternate; on inversion always clamp end = start (never move the start).
    const pick = (ds: string) => {
      if (act === "start") {
        state.start = ds;
        if (state.end && ds > state.end) state.end = ds; // end follows forward
        act = "end";
      } else {
        // picking before the start clamps end to the start
        state.end = state.start && ds < state.start ? state.start : ds;
        act = "start";
      }
      void save();
      render();
    };

    const renderDay = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { if (--m < 1) { m = 12; y--; } render(); };
      // click the title to open the year view
      const title = head.createEl("button", { cls: "ogantt-cal-title", text: `${y} / ${pad2(m)}` });
      title.onclick = () => { mode = "year"; render(); };
      const next = head.createEl("button", { cls: "clickable-icon" });
      setIcon(next, "chevron-right");
      next.onclick = () => { if (++m > 12) { m = 1; y++; } render(); };

      cal.createDiv({ cls: "ogantt-cal-active", text: `▸ ${act === "start" ? tr().fieldStart : tr().fieldDue}` });

      const wkRow = cal.createDiv({ cls: "ogantt-cal-wk" });
      wk.forEach((w) => wkRow.createSpan({ text: w }));

      const grid = cal.createDiv({ cls: "ogantt-cal-grid" });
      const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let i = 0; i < firstDow; i++) grid.createSpan({ cls: "ogantt-cal-pad" });
      for (let d = 1; d <= dim; d++) {
        const ds = `${y}-${pad2(m)}-${pad2(d)}`;
        const cell = grid.createEl("button", { cls: "ogantt-cal-day", text: String(d) });
        if (ds === todayStr) cell.addClass("is-today");
        if (ds === state.start) cell.addClass("is-range-start");
        if (ds === state.end) cell.addClass("is-range-end");
        if (state.start && state.end && ds > state.start && ds < state.end) cell.addClass("is-in-range");
        cell.onclick = () => pick(ds);
      }

      const foot = cal.createDiv({ cls: "ogantt-cal-foot" });
      const todayBtn = foot.createEl("button", { text: tr().today });
      todayBtn.onclick = () => {
        y = parseInt(todayStr.slice(0, 4), 10);
        m = parseInt(todayStr.slice(5, 7), 10); // move the view to today's month
        pick(todayStr);
      };
      const clearBtn = foot.createEl("button", { text: tr().clearDate });
      clearBtn.onclick = () => { state[act] = ""; void save(); render(); };
    };

    const renderYear = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { y--; render(); }; // ←/→ change the year
      head.createSpan({ cls: "ogantt-cal-title", text: `${y}` });
      const next = head.createEl("button", { cls: "clickable-icon" });
      setIcon(next, "chevron-right");
      next.onclick = () => { y++; render(); };

      const grid = cal.createDiv({ cls: "ogantt-cal-months" });
      for (let mm = 1; mm <= 12; mm++) {
        const cell = grid.createEl("button", { cls: "ogantt-cal-month", text: months[mm - 1] });
        if (mm === m) cell.addClass("is-current");
        const ym = `${y}-${pad2(mm)}`;
        if (state.start.startsWith(ym) || state.end.startsWith(ym)) cell.addClass("is-selected"); // months holding an endpoint
        cell.onclick = () => { m = mm; mode = "day"; render(); };
      }
    };

    const render = () => {
      cal.empty();
      if (mode === "year") renderYear();
      else renderDay();
    };
    render();
  });
}
