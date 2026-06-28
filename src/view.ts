import { ItemView, Menu, WorkspaceLeaf, setIcon, Notice, TFile, ViewStateResult } from "obsidian";
import type GanttPlugin from "./main";
import { Task, Row, ZoomMode, GanttViewState, VIEW_TYPE_GANTT } from "./types";
import { WheelGestureRouter } from "./wheelGesture";
import {
  collectTasks,
  collectFolders,
  buildRows,
  createTask,
  reparentTask,
  subtreePaths,
  writeField,
  deleteTask,
  addTag,
  anchorStart,
  anchorEnd,
  processTasks,
} from "./model";
import {
  DateRange,
  computeRange,
  dayIndex,
  dayToStr,
  pxPerDay,
  todayIndex,
} from "./timeline";
import { t as tr } from "./i18n"; // aliased to avoid clashing with the `t` task var
import {
  ROW_H,
  MIN_PPD,
  MAX_PPD,
  FALLBACK_BAR,
  ColumnId,
  COLUMN_ORDER,
  OPTIONAL_COLUMNS,
  COLUMN_WIDTHS,
} from "./viewConstants";
import { hashColor, tagColor, folderColor } from "./color";
import { ConfirmModal } from "./confirmModal";
import { TextMeasurer, svgEl } from "./svg";
import { openPopover } from "./dom/popover";
import { legendChip } from "./dom/legendChip";
import { ViewCtx } from "./render/context";
import { renderGrid } from "./render/grid";

// measure the real vertical scrollbar width once (0 with macOS overlay scrollbars);
// a fixed pad would otherwise show as a gap where the scrollbar is thin or absent.
let cachedScrollbarW: number | null = null;
function scrollbarWidth(): number {
  if (cachedScrollbarW != null) return cachedScrollbarW;
  const probe = activeDocument.body.createDiv();
  probe.setCssStyles({ position: "absolute", visibility: "hidden", overflow: "scroll", width: "60px", height: "60px" });
  cachedScrollbarW = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return cachedScrollbarW;
}

export class GanttView extends ItemView {
  plugin: GanttPlugin;
  private zoom: ZoomMode;
  private tasks: Task[] = [];
  private rows: Row[] = [];
  private range: DateRange = { min: 0, max: 0 };
  private contentRange: DateRange = { min: 0, max: 0 }; // actual task bounds (no buffer); used to place the initial scroll
  private rangeOverride: DateRange | null = null; // widened range for endless scroll (merged with task bounds)
  private extending = false; // guard while extending at an edge (prevents re-entrant scroll handling)
  private suppressExtend = false; // set when we set scrollLeft ourselves, so the resulting scroll event isn't treated as a user edge-scroll
  private suppressExtendTimer: number | null = null;
  private ppd = 16;
  // free wheel-zoom override (null = follow the zoom mode)
  private customPpd: number | null = null;
  private wheelRAF = 0; // coalesce wheel bursts to one rerender per frame
  private wheelRouter = new WheelGestureRouter(); // routes a gesture to an axis (x=scroll, y=zoom)
  // In-bar label text measurer; reads the font family lazily from the grid host (set after attach).
  private measurer = new TextMeasurer(() => this.gridHost);
  private selectedPath: string | null = null;
  private folder = ""; // scoped folder path
  private collapsed = new Set<string>(); // collapsed folder keys

  // view options (kept while the view is open)
  private colorBy: "status" | "assignee" = "status";
  private groupBy: "folder" | "status" | "assignee" | "tag" = "folder";
  private filterAssignee = ""; // "" = all
  private filterTag = ""; // "" = all
  private hiddenStatuses = new Set<string>(); // statuses unchecked in the legend (empty = show all)
  private showEmptyFolders = true; // show empty folders as rows (default on)
  private flat = false; // flat list ignoring folders & nesting
  private rollup = false; // draw parent bars as a rollup of descendants (default off)
  private allFolders: string[][] = []; // all folders under scope
  private optionsHost!: HTMLElement; // options + legend container

  // undo history: a pre-op content snapshot and/or file moves (array of from → to)
  private undoStack: { label: string; files?: Map<string, string>; moves?: { from: string; to: string }[] }[] = [];
  private static readonly UNDO_LIMIT = 50;

  // whether a bar was dragged (to suppress the trailing click)
  private dragged = new WeakMap<SVGGElement, boolean>();

  // debounce timer to re-fit in Fit mode
  private fitTimer: number | null = null;
  private lastRenderWidth = 0; // pane width at last render; skips a needless rerender when returning to the tab (width unchanged)
  private renderPending = false; // a render deferred while hidden, flushed by onResize on re-show
  private zoomBtns = new Map<ZoomMode, HTMLButtonElement>(); // zoom buttons; kept so the active highlight can be cleared on manual zoom
  private scrollAnchorDay: number | null = null; // last timeline left-edge day (getState fallback when the DOM is gone)
  private pendingScrollDay: number | null = null; // left-edge day to restore from a reload (applied on the next rerender)
  private scrollSaveTimer: number | null = null; // debounce timer to persist scroll position after scrolling

  // DOM refs
  private tbodyEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private noteLeaf: WorkspaceLeaf | null = null; // reused right-sidebar leaf showing the task note
  private undoBtn: HTMLButtonElement | null = null;
  private projectProgressEl: HTMLElement | null = null; // overall-progress readout on the right of the toolbar

  constructor(leaf: WorkspaceLeaf, plugin: GanttPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.zoom = plugin.settings.defaultZoom;
  }

  getViewType(): string {
    return VIEW_TYPE_GANTT;
  }
  getDisplayText(): string {
    const name = this.folder ? this.folder.split("/").pop() : "(vault)";
    return `Gantt: ${name}`;
  }
  getIcon(): string {
    return "gantt-chart";
  }

  // persist scope + view options/filters (across reloads/restarts)
  getState(): Record<string, unknown> {
    const s: Record<string, unknown> = {
      folder: this.folder,
      colorBy: this.colorBy,
      groupBy: this.groupBy,
      filterAssignee: this.filterAssignee,
      filterTag: this.filterTag,
      hiddenStatuses: [...this.hiddenStatuses],
      flat: this.flat,
      showEmptyFolders: this.showEmptyFolders,
      rollup: this.rollup,
      zoom: this.zoom,
    };
    // always persist the scroll position except in Fit (which re-fits on reload); also save the custom scale when wheel-zoomed.
    if (this.customPpd != null) s.customPpd = this.customPpd;
    const anchor = this.currentAnchorDay();
    if (anchor != null) s.scrollDay = anchor;
    return s;
  }

  // fractional day at the timeline's left edge, used to restore scroll across reloads
  private currentAnchorDay(): number | null {
    const main = this.gridHost?.querySelector<HTMLElement>(".ogantt-main");
    if (main && this.ppd > 0) return this.range.min + main.scrollLeft / this.ppd;
    return this.scrollAnchorDay; // fall back to the cached value when there's no DOM (hidden/deferred)
  }
  async setState(state: GanttViewState, result: ViewStateResult): Promise<void> {
    if (state && typeof state.folder === "string") this.folder = state.folder;
    if (state?.colorBy) this.colorBy = state.colorBy;
    if (state?.groupBy) this.groupBy = state.groupBy;
    if (typeof state?.filterAssignee === "string") this.filterAssignee = state.filterAssignee;
    if (typeof state?.filterTag === "string") this.filterTag = state.filterTag;
    if (Array.isArray(state?.hiddenStatuses)) this.hiddenStatuses = new Set(state.hiddenStatuses);
    if (typeof state?.flat === "boolean") this.flat = state.flat;
    if (typeof state?.showEmptyFolders === "boolean") this.showEmptyFolders = state.showEmptyFolders;
    if (typeof state?.rollup === "boolean") this.rollup = state.rollup;
    if (state?.zoom) this.zoom = state.zoom;
    // restore scale and scroll; customPpd exists only for wheel zoom; scrollDay is restored for presets too.
    this.customPpd = typeof state?.customPpd === "number" ? state.customPpd : null;
    this.pendingScrollDay = typeof state?.scrollDay === "number" ? state.scrollDay : null;
    await super.setState(state, result);
    if (this.gridHost) await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    await this.refresh();
    // re-render the grid when frontmatter changes
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    // also re-render on create / delete / rename (incl. folder moves)
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    // Ctrl/Cmd+Z to undo (defer to native undo while an input is focused)
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return;
      const ae = activeDocument.activeElement as HTMLElement | null;
      // defer to native undo only while editing text (time-like inputs shouldn't swallow the gantt undo)
      const editingText =
        !!ae &&
        (ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          (ae.instanceOf(HTMLInputElement) &&
            ["text", "search", "url", "tel", "password", "email", "number"].includes(ae.type)));
      if (editingText) return;
      e.preventDefault();
      void this.undo();
    });
  }

  // Obsidian calls this on pane/window resize; re-fit in Fit mode only (debounced)
  onResize(): void {
    const w = this.gridHost?.clientWidth ?? 0;
    if (w === 0) return; // still hidden
    // flush a render that was deferred while hidden
    if (this.renderPending) { this.rerender(); return; }
    // once a wheel zoom overrides Fit (customPpd set), don't re-fit: a rerender would reset scrollLeft
    if (this.zoom !== "Fit" || this.customPpd != null) return;
    // same width as the last render = the pane was merely re-shown (tab return); skip the rerender to avoid a full content reload
    if (w === this.lastRenderWidth) return;
    if (this.fitTimer != null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.rerender(), 80);
  }

  // persistent toolbar; only the grid re-renders
  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ogantt-board");
    this.renderToolbar(root);
    this.optionsHost = root.createDiv({ cls: "ogantt-options" }); // repopulated on rerender
    this.gridHost = root.createDiv({ cls: "ogantt-host" });
    // vertical wheel / two-finger up-down swipe zooms smoothly, anchored under the cursor (horizontal swipe still scrolls)
    // non-passive so preventDefault can cancel the scroll
    this.registerDomEvent(this.gridHost, "wheel", (e: WheelEvent) => this.onWheelZoom(e), { passive: false });
  }

  private refreshTimer: number | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 300);
  }

  // stop the pending timer on close
  async onClose(): Promise<void> {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.fitTimer != null) {
      window.clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    if (this.scrollSaveTimer != null) {
      window.clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
    activeDocument.querySelectorAll(".ogantt-cal, .ogantt-colmenu").forEach((e) => e.remove()); // drop any open popover
  }

  // re-collect from disk, then render
  async refresh(): Promise<void> {
    if (!this.gridHost) this.buildSkeleton();
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.allFolders = collectFolders(this.app, this.plugin.settings, this.folder);
    this.rerender();
  }

  // render from in-memory tasks (no disk read)
  // shows correct positions before metadataCache updates
  rerender(): void {
    this.app.workspace.requestSaveLayout(); // persist filter changes to workspace state (debounced)
    if (!this.gridHost) this.buildSkeleton();
    // defer the draw while the pane is hidden (width 0): Fit's ppd is width-derived, so drawing at 0 is wrong.
    // onResize flushes it once the pane is shown again; this also no-ops background data-change rerenders.
    if (this.gridHost.clientWidth === 0) { this.renderPending = true; return; }
    this.renderPending = false;
    this.lastRenderWidth = this.gridHost.clientWidth; // baseline so a same-width re-show skips the rerender
    this.renderOptions(); // refresh options + legend
    this.updateProjectProgress(); // refresh overall progress from current data
    this.updateZoomButtons(); // drop the preset highlight while a manual zoom is active
    const view = processTasks(this.tasks, {
      filterAssignee: this.filterAssignee,
      filterTag: this.filterTag,
      hiddenStatuses: this.hiddenStatuses,
      groupBy: this.groupBy,
      flat: this.flat,
      statuses: this.plugin.settings.statuses,
      noneLabel: tr().noneLabel,
    }); // after filter + group remap
    const compare = this.taskComparator();
    if (this.flat) {
      // flat: one sorted list, no grouping/nesting
      this.rows = view.slice().sort(compare).map((task) => ({ kind: "task", group: "", depth: 0, task } as Row));
    } else {
      // seed empty folders only when grouping by folder and the option is on
      const folders = this.showEmptyFolders && this.groupBy === "folder" ? this.allFolders : [];
      // nest by parent only when grouping by folder
      this.rows = buildRows(view, this.collapsed, folders, compare, this.groupBy === "folder");
    }
    // capture the left-edge day BEFORE the scale changes; restoring by day (not raw pixels) keeps
    // the view put across a zoom switch — a pixel offset means a different date at a different px/day.
    const prevAnchorDay = this.currentAnchorDay();
    this.contentRange = computeRange(view); // actual task bounds; Fit's ppd and the initial scroll derive from this
    this.ppd = this.computePpd();
    this.range = this.effectiveRange();
    const titleEl = this.contentEl.querySelector(".ogantt-title");
    if (titleEl) titleEl.setText(this.folder || "(vault root)");

    this.gridHost.empty();
    // render if there are rows (even empty folders)
    if (this.rows.length === 0) {
      this.gridHost.createDiv({ cls: "ogantt-empty" }).setText(
        tr().emptyMessage(this.folder || "vault")
      );
      return;
    }
    const main = this.gridHost.createDiv({ cls: "ogantt-main" });
    // extend the range near the edges = endless scroll
    main.addEventListener("scroll", () => this.onTimelineScroll(main), { passive: true });
    renderGrid(this.ctx(), main);
    // scroll position priority: (1) restore from a reload (left-edge day), (2) Fit always shows the
    // whole span from its start, (3) keep the prior left-edge day across a rerender/zoom switch,
    // (4) content start on first render.
    const contentStart = (this.contentRange.min - this.range.min) * this.ppd;
    if (this.pendingScrollDay != null) {
      this.setScrollLeft(main, (this.pendingScrollDay - this.range.min) * this.ppd);
      this.pendingScrollDay = null; // apply once
    } else if (this.zoom === "Fit" && this.customPpd == null) {
      this.setScrollLeft(main, contentStart); // Fit fills the pane: start at the content's left edge
    } else if (prevAnchorDay != null) {
      this.setScrollLeft(main, (prevAnchorDay - this.range.min) * this.ppd);
    } else {
      this.setScrollLeft(main, contentStart);
    }
    this.pinTableColumn(main); // pin the left table at the initial position too (before any scroll event)
  }

  // pixels-per-day; Fit derives it from the pane width (falls back to scrolling below MIN_PPD)
  private computePpd(): number {
    // wheel zoom overrides the mode (and Fit)
    if (this.customPpd != null) return Math.min(MAX_PPD, Math.max(MIN_PPD, this.customPpd));
    if (this.zoom !== "Fit") return pxPerDay(this.zoom);
    // use the actual task span (no buffer) for Fit scale
    const totalDays = Math.max(1, this.contentRange.max - this.contentRange.min + 1);
    // 1px safety margin: filling the width *exactly* lets float rounding push scrollWidth just past
    // clientWidth, which shows a full-width horizontal scrollbar. Subtracting 1px guarantees it fits (invisible).
    const avail = (this.gridHost?.clientWidth ?? 0) - this.tableWidth() - scrollbarWidth() - 1;
    if (avail <= 0) return pxPerDay("Week"); // not laid out yet
    // use a fractional px/day (no floor) so totalDays*ppd ≈ avail — no visible gap on the right.
    // only fall back to MIN_PPD (with horizontal scroll) when it can't fit.
    const ppd = avail / totalDays;
    return ppd >= MIN_PPD ? ppd : MIN_PPD;
  }

  // visible range: task bounds + a buffer each side (widened via override for endless scroll).
  // Fit is no longer special-cased: it auto-scales the span to the pane width (computePpd) but gets
  // the same buffer + endless scroll as the presets, so it doesn't look clamped to the task bounds.
  private effectiveRange(): DateRange {
    const base = this.contentRange;
    const ppd = this.ppd > 0 ? this.ppd : pxPerDay(this.zoom);
    const vpDays = Math.ceil((this.gridHost?.clientWidth ?? 800) / Math.max(1, ppd));
    const pad = Math.max(90, vpDays * 2); // ~2 viewports each side (min 90 days)
    let min = base.min - pad;
    let max = base.max + pad;
    if (this.rangeOverride) {
      min = Math.min(min, this.rangeOverride.min);
      max = Math.max(max, this.rangeOverride.max);
    }
    return { min, max };
  }

  // pin the left table (header + body) to the horizontal scroll; sticky-left is clamped to the grid area in a CSS grid, so we use a transform instead
  private pinTableColumn(main: HTMLElement): void {
    const x = `translateX(${main.scrollLeft}px)`;
    const corner = main.querySelector<HTMLElement>(".ogantt-corner");
    const body = main.querySelector<HTMLElement>(".ogantt-tbody");
    if (corner) corner.style.transform = x;
    if (body) body.style.transform = x;
  }

  // set scrollLeft ourselves without the resulting scroll event being read as a user edge-scroll (which would endlessly extend the range → freeze)
  private setScrollLeft(m: HTMLElement, value: number): void {
    this.suppressExtend = true;
    m.scrollLeft = Math.max(0, value);
    // safety net: clear the flag a frame later in case no scroll event fires (e.g. value unchanged)
    if (this.suppressExtendTimer != null) window.clearTimeout(this.suppressExtendTimer);
    this.suppressExtendTimer = window.setTimeout(() => { this.suppressExtend = false; }, 150);
  }

  // extend the range near an edge for endless scrolling
  private onTimelineScroll(main: HTMLElement): void {
    this.pinTableColumn(main); // keep the left table pinned first
    if (this.ppd > 0) this.scrollAnchorDay = this.range.min + main.scrollLeft / this.ppd; // cache the left-edge day for restore across reloads
    // save workspace state 300ms after scrolling so position survives reload
    if (this.scrollSaveTimer != null) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => this.app.workspace.requestSaveLayout(), 300);
    if (this.extending) return;
    if (this.suppressExtend) { this.suppressExtend = false; return; } // our own programmatic scroll, not the user — don't extend
    const threshold = main.clientWidth; // extend one viewport before the edge
    const maxScroll = main.scrollWidth - main.clientWidth;
    const chunk = Math.max(90, Math.ceil(main.clientWidth / Math.max(1, this.ppd)));
    if (main.scrollLeft <= threshold) this.extendRange("left", chunk, main);
    else if (main.scrollLeft >= maxScroll - threshold) this.extendRange("right", chunk, main);
  }

  // widen the range by `chunk` days on one side and rerender; left growth shifts content right, so offset the scroll to keep the view fixed
  private extendRange(side: "left" | "right", chunk: number, main: HTMLElement): void {
    this.extending = true;
    const before = main.scrollLeft;
    const cur = this.rangeOverride ?? { ...this.range };
    this.rangeOverride = side === "left"
      ? { min: cur.min - chunk, max: cur.max }
      : { min: cur.min, max: cur.max + chunk };
    this.rerender();
    const m = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    if (m) {
      this.setScrollLeft(m, side === "left" ? before + chunk * this.ppd : before);
      this.pinTableColumn(m); // re-pin the left table at the new scroll position
    }
    this.extending = false;
  }

  // wheel/trackpad gesture; axis decision is delegated to WheelGestureRouter (vertical = zoom, horizontal = scroll).
  private onWheelZoom(e: WheelEvent): void {
    const main = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    // over the pinned left table column, don't hijack the wheel — let the browser scroll the rows
    // natively (so a long task list is scrollable). Zoom/h-scroll apply over the timeline only.
    if (e.clientX - rect.left < this.tableWidth()) {
      this.wheelRouter.reset(); // clear axis state so it doesn't carry over
      return; // no preventDefault: native scroll handles it
    }
    const axis = this.wheelRouter.route(e);
    if (axis == null) {
      // still deciding: swallow the default scroll and wait
      e.preventDefault();
      return;
    }
    if (axis === "x") {
      // horizontal swipe scrolls the timeline only; vertical component ignored
      e.preventDefault();
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * main.clientWidth : e.deltaX;
      // Fit now has a buffer + endless scroll like the presets, so a horizontal swipe just scrolls it.
      main.scrollLeft += dx;
      return;
    }
    // vertical swipe = smooth zoom anchored under the cursor
    e.preventDefault();
    const tableW = this.tableWidth();
    const screenX = e.clientX - rect.left; // cursor x within the pane
    // fractional day under the cursor (timeline starts after the sticky table)
    const dayUnder = this.range.min + (screenX + main.scrollLeft - tableW) / this.ppd;
    // normalize deltaMode to px (mouse: lines/pages, trackpad: px)
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * rect.height : e.deltaY;
    // exponential step keeps the feel constant at any scale
    const next = Math.min(MAX_PPD, Math.max(MIN_PPD, this.ppd * Math.exp(-dy * 0.0015)));
    if (next === this.ppd && this.customPpd != null) return; // clamped at a limit
    this.customPpd = next;
    // rerender loses the vertical scroll; zoom shouldn't move it, so keep scrollTop and restore it after.
    const topBefore = main.scrollTop;
    // one rerender per frame; after it, fix scrollLeft so dayUnder stays under the cursor.
    if (this.wheelRAF) return;
    this.wheelRAF = requestAnimationFrame(() => {
      this.wheelRAF = 0;
      this.rerender();
      const m = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
      if (m) {
        this.setScrollLeft(m, tableW + (dayUnder - this.range.min) * this.ppd - screenX);
        m.scrollTop = topBefore; // keep the vertical position so the table doesn't jump up
        this.pinTableColumn(m); // re-pin the left table after the zoom adjusts scroll
      }
    });
  }

  // ----- table columns -----
  // visible columns (name always; rest per settings)
  private visibleColumns(): ColumnId[] {
    const vis = new Set(this.plugin.settings.visibleColumns ?? []);
    return COLUMN_ORDER.filter((id) => id === "name" || vis.has(id));
  }
  // total table width (sum of visible column widths)
  private tableWidth(): number {
    return this.visibleColumns().reduce((w, id) => w + this.colW(id), 0);
  }

  // effective column width (user override > default)
  private colW(id: ColumnId): number {
    return this.plugin.settings.columnWidths[id] ?? COLUMN_WIDTHS[id];
  }

  // auto-fit a column to its content (grip double-press): measure by temporarily sizing cells to max-content
  private autoFitColumn(id: ColumnId, nth: number, th: HTMLElement): void {
    const cells: HTMLElement[] = [th];
    this.tbodyEl
      ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
      .forEach((el) => cells.push(el));
    // remove inline widths while measuring so the measuring class applies without !important
    const saved = cells.map((el) => el.style.width);
    cells.forEach((el) => {
      el.style.removeProperty("width");
      el.addClass("ogantt-measure");
    });
    const w = Math.max(40, ...cells.map((el) => el.offsetWidth)) + 2;
    cells.forEach((el, i) => {
      el.removeClass("ogantt-measure");
      el.style.width = saved[i];
    });
    this.plugin.settings.columnWidths[id] = w;
    void this.plugin.saveSettings(); // persist (views refresh)
  }
  // column header label
  private colLabel(id: ColumnId): string {
    switch (id) {
      case "name": return tr().colTask;
      case "start": return tr().colStart;
      case "end": return tr().colDue;
      case "assignee": return tr().fieldAssignee;
      case "status": return tr().fieldStatus;
      case "tags": return tr().fieldTags;
    }
  }
  // build a task comparator from the current sort settings
  private taskComparator(): (a: Task, b: Task) => number {
    const by = this.plugin.settings.sortBy as ColumnId;
    const dir = this.plugin.settings.sortDir === "desc" ? -1 : 1;
    // status sorts by the configured order, not alphabetically
    const statusOrder = new Map(this.plugin.settings.statuses.map((s, i) => [s.id, i]));
    const key = (t: Task): string | number => {
      switch (by) {
        case "name": return t.name.toLowerCase();
        case "start": return anchorStart(t) ?? "9999-99-99";
        case "end": return anchorEnd(t) ?? "9999-99-99";
        case "assignee": return (t.assignee ?? "").toLowerCase();
        case "status": return t.status != null ? statusOrder.get(t.status) ?? 999 : 999;
        case "tags": return t.tags.join(",").toLowerCase();
        default: return anchorStart(t) ?? "9999-99-99";
      }
    };
    return (a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return c * dir;
    };
  }

  // clicking a header toggles sort column/direction (persisted)
  private toggleSort(id: ColumnId): void {
    const s = this.plugin.settings;
    if (s.sortBy === id) s.sortDir = s.sortDir === "asc" ? "desc" : "asc";
    else {
      s.sortBy = id;
      s.sortDir = "asc";
    }
    void this.plugin.saveData(s);
    this.rerender();
  }

  // toggle a column's visibility and persist
  private setColumnVisible(id: ColumnId, on: boolean): void {
    const set = new Set(this.plugin.settings.visibleColumns ?? []);
    if (on) set.add(id);
    else set.delete(id);
    this.plugin.settings.visibleColumns = OPTIONAL_COLUMNS.filter((c) => set.has(c)); // keep master order
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // column-visibility popover (checkboxes)
  private openColumnMenu(anchor: HTMLElement): void {
    openPopover({ cls: "ogantt-colmenu", anchor }, (menu) => {
      for (const id of OPTIONAL_COLUMNS) {
        const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
        const cb = item.createEl("input", { type: "checkbox" });
        cb.checked = (this.plugin.settings.visibleColumns ?? []).includes(id);
        item.createSpan({ text: this.colLabel(id) });
        cb.addEventListener("change", () => this.setColumnVisible(id, cb.checked));
      }
    });
  }

  // ----- toolbar -----
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ogantt-toolbar" });
    bar.createSpan({ cls: "ogantt-title", text: this.plugin.settings.rootFolder || "(vault root)" });
    // add a new task (icon + label)
    const add = bar.createEl("button", { cls: "ogantt-add" });
    setIcon(add, "plus");
    add.createSpan({ cls: "ogantt-add-label", text: tr().newTaskName });
    add.setAttr("aria-label", tr().newTaskAria);
    add.onclick = () => void this.createNewTask();
    // keep the following controls left-packed next to the "+" button
    // scroll to today
    const todayBtn = bar.createEl("button", { cls: "ogantt-today-btn", text: tr().today });
    todayBtn.onclick = () => this.scrollToToday();
    this.zoomBtns.clear();
    (["Day", "Week", "Month", "Fit"] as ZoomMode[]).forEach((z) => {
      const btn = bar.createEl("button", { text: z });
      this.zoomBtns.set(z, btn);
      btn.onclick = () => {
        this.zoom = z; // ppd is set by computePpd() in rerender
        this.customPpd = null; // picking a mode drops the wheel-zoom override
        void this.refresh(); // the rerender refreshes the active highlight
      };
    });
    this.updateZoomButtons();
    // undo button
    const undo = bar.createEl("button");
    setIcon(undo, "undo-2");
    undo.setAttr("aria-label", tr().undoAria);
    undo.onclick = () => void this.undo();
    this.undoBtn = undo;
    this.updateUndoButton();

    const reload = bar.createEl("button");
    setIcon(reload, "refresh-cw");
    reload.setAttr("aria-label", tr().reloadAria);
    reload.onclick = () => void this.refresh();

    // trailing spacer keeps controls left-packed
    bar.createDiv({ cls: "ogantt-spacer" });

    // overall progress (duration-weighted mean; updates live during resize)
    const prog = bar.createDiv({ cls: "ogantt-project-progress" });
    const track = prog.createDiv({ cls: "ogantt-project-progress-track" });
    track.createDiv({ cls: "ogantt-project-progress-fill" });
    prog.createSpan({ cls: "ogantt-project-progress-val" });
    this.projectProgressEl = prog;
    this.updateProjectProgress();
  }

  // sync the zoom buttons' active highlight; while a manual zoom (customPpd) is active, no preset is highlighted
  private updateZoomButtons(): void {
    this.zoomBtns.forEach((btn, z) => btn.toggleClass("is-active", this.customPpd == null && z === this.zoom));
  }

  // a task's span in days (0 = no dates → no weight)
  private taskDays(t: Task): number {
    const s = anchorStart(t);
    if (!s) return 0;
    return Math.max(1, dayIndex(anchorEnd(t) ?? s) - dayIndex(s) + 1);
  }

  // overall progress = Σ(days × progress) / Σ(days); override swaps the dragged task's days for a live figure
  private computeProjectProgress(override?: { path: string; days: number }): number {
    let weighted = 0;
    let total = 0;
    for (const t of this.tasks) {
      const d = override && t.path === override.path ? override.days : this.taskDays(t);
      if (d <= 0) continue;
      total += d;
      weighted += d * Math.min(100, Math.max(0, t.progress ?? 0));
    }
    return total > 0 ? weighted / total : 0;
  }

  private updateProjectProgress(override?: { path: string; days: number }): void {
    const el = this.projectProgressEl;
    if (!el) return;
    const pct = Math.round(this.computeProjectProgress(override));
    const fill = el.querySelector<HTMLElement>(".ogantt-project-progress-fill");
    const val = el.querySelector<HTMLElement>(".ogantt-project-progress-val");
    if (fill) fill.style.width = `${pct}%`;
    if (val) val.textContent = `${pct}%`;
    el.setAttr("aria-label", `${tr().fieldProgress}: ${pct}%`);
  }

  // ----- view options (group/color/filter) + legend -----
  // rebuilt each rerender (depends on data)
  private renderOptions(): void {
    const host = this.optionsHost;
    host.empty();
    const statuses = this.plugin.settings.statuses;
    const none = tr().noneLabel;
    // assignees actually present in the current folder
    const assignees = [...new Set(this.tasks.map((t) => t.assignee).filter((a): a is string => !!a))].sort();
    // tags actually present in the current folder
    const tags = [...new Set(this.tasks.flatMap((t) => t.tags))].sort();

    const makeSelect = (icon: string, label: string, value: string, opts: [string, string][], on: (v: string) => void): void => {
      const wrap = host.createDiv({ cls: "ogantt-opt" });
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      ic.setAttr("aria-label", label); // tooltip explains the icon
      const sel = wrap.createEl("select");
      for (const [val, text] of opts) {
        const o = sel.createEl("option", { text, value: val });
        if (val === value) o.selected = true;
      }
      sel.addEventListener("change", () => on(sel.value));
    };

    // checkbox (the whole label toggles it)
    const makeCheckbox = (icon: string, label: string, checked: boolean, on: (v: boolean) => void): void => {
      const wrap = host.createEl("label", { cls: "ogantt-opt ogantt-opt-check" });
      const cb = wrap.createEl("input", { type: "checkbox" });
      cb.checked = checked;
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      wrap.createSpan({ text: label });
      cb.addEventListener("change", () => on(cb.checked));
    };

    // column visibility (gear) — leftmost of the options row
    const colBtn = host.createEl("button", { cls: "ogantt-opt-gear clickable-icon" });
    setIcon(colBtn, "settings");
    colBtn.setAttr("aria-label", tr().optColumns);
    colBtn.onclick = () => this.openColumnMenu(colBtn);

    // ── layout (group + color) ──
    // group by
    makeSelect(
      "layers",
      tr().optGroupLabel,
      this.groupBy,
      [["folder", tr().optGroupFolder], ["status", tr().fieldStatus], ["assignee", tr().fieldAssignee], ["tag", tr().fieldTags]],
      (v) => { this.groupBy = v as typeof this.groupBy; this.collapsed.clear(); this.rerender(); }
    );
    // color by
    makeSelect(
      "palette",
      tr().optColorLabel,
      this.colorBy,
      [["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
      (v) => {
        this.colorBy = v as typeof this.colorBy;
        // the status legend-filter is only operable while coloring by status, so clear it otherwise to avoid an invisible filter
        if (this.colorBy !== "status") this.hiddenStatuses.clear();
        this.rerender();
      }
    );

    // ── divider before filters ──
    host.createDiv({ cls: "ogantt-opt-divider" });

    // filter by assignee
    makeSelect(
      "user",
      tr().fieldAssignee,
      this.filterAssignee,
      [["", tr().filterAll], ...assignees.map((a) => [a, a] as [string, string])],
      (v) => { this.filterAssignee = v; this.rerender(); }
    );
    // filter by tag (hidden when no tags exist)
    if (tags.length > 0) {
      makeSelect(
        "tag",
        tr().fieldTags,
        this.filterTag,
        [["", tr().filterAll], ...tags.map((tg) => [tg, tg] as [string, string])],
        (v) => { this.filterTag = v; this.rerender(); }
      );
    }
    // show-empty-folders (folder grouping only; off in flat)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("folder", tr().optShowEmpty, this.showEmptyFolders, (v) => {
        this.showEmptyFolders = v;
        this.rerender();
      });
    }
    // rollup (folder grouping only)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("git-merge", tr().optRollup, this.rollup, (v) => {
        this.rollup = v;
        this.rerender();
      });
    }
    // flat view (all tasks, no grouping/nesting)
    makeCheckbox("list", tr().optFlat, this.flat, (v) => {
      this.flat = v;
      this.rerender();
    });

    // legend explaining the current color basis
    const legend = host.createDiv({ cls: "ogantt-legend" });
    if (this.colorBy === "status") {
      // legend doubles as a status toggle-filter (all on by default, click to drop)
      for (const s of statuses) {
        const on = !this.hiddenStatuses.has(s.id);
        legendChip(legend, s.color, s.label, () => {
          if (this.hiddenStatuses.has(s.id)) this.hiddenStatuses.delete(s.id);
          else this.hiddenStatuses.add(s.id);
          this.rerender();
        }, on);
      }
    } else {
      for (const a of assignees) legendChip(legend, hashColor(a), a);
      if (this.tasks.some((t) => !t.assignee)) legendChip(legend, FALLBACK_BAR, none);
    }
  }

  // set or clear a tag/folder color override (null = reset to auto)
  private setColorOverride(kind: "tag" | "folder", name: string, color: string | null): void {
    const arr = kind === "tag" ? this.plugin.settings.tagColors : this.plugin.settings.folderColors;
    const i = arr.findIndex((c) => c.name === name);
    if (color == null) {
      if (i >= 0) arr.splice(i, 1); // reset = drop the override
    } else if (i >= 0) {
      arr[i].color = color;
    } else {
      arr.push({ name, color });
    }
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // right-click color menu (change → native picker; reset → auto)
  private openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void {
    const current = kind === "tag" ? tagColor(this.plugin.settings, name) : folderColor(this.plugin.settings, name);
    const m = new Menu();
    m.addItem((i) => i.setTitle(tr().menuChangeColor).setIcon("palette").onClick(() => {
      // spawn a hidden color input to open the native picker
      const picker = activeDocument.body.createEl("input", { type: "color", cls: "ogantt-hidden-color-input" });
      picker.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#888888";
      picker.addEventListener("change", () => {
        this.setColorOverride(kind, name, picker.value);
        picker.remove();
      });
      picker.click();
    }));
    m.addItem((i) => i.setTitle(tr().menuResetColor).setIcon("rotate-ccw").onClick(() => this.setColorOverride(kind, name, null)));
    m.showAtMouseEvent(e);
  }

  // scroll horizontally so the today marker is centered
  private scrollToToday(): void {
    const main = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    const todayLine = main?.querySelector<SVGElement>(".ogantt-today");
    if (!main || !todayLine) return; // no marker when today is out of range
    const mb = main.getBoundingClientRect();
    const tb = todayLine.getBoundingClientRect();
    main.scrollLeft += tb.left - mb.left - main.clientWidth / 2;
  }

  // ----- Undo -----
  // snapshot current task files before an op
  private async pushUndo(label: string): Promise<void> {
    const files = new Map<string, string>();
    for (const t of this.tasks) {
      const f = this.app.vault.getAbstractFileByPath(t.path);
      if (f instanceof TFile) files.set(t.path, await this.app.vault.read(f));
    }
    this.undoStack.push({ label, files });
    if (this.undoStack.length > GanttView.UNDO_LIMIT) this.undoStack.shift();
    this.updateUndoButton();
  }

  // record a reparent/move (on undo: replay moves in reverse, then restore src's old content)
  private pushUndoReparent(label: string, moves: { from: string; to: string }[], srcOrigPath: string, oldContent: string): void {
    this.undoStack.push({ label, moves, files: new Map([[srcOrigPath, oldContent]]) });
    if (this.undoStack.length > GanttView.UNDO_LIMIT) this.undoStack.shift();
    this.updateUndoButton();
  }

  // revert the most recent op (undo moves, then restore content)
  private async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToUndo);
      return;
    }
    // 1) undo moves in reverse (rename to → from)
    if (entry.moves) {
      for (const m of [...entry.moves].reverse()) {
        const f = this.app.vault.getAbstractFileByPath(m.to);
        if (f instanceof TFile) {
          await this.app.fileManager.renameFile(f, m.from);
          if (this.selectedPath === m.to) this.selectedPath = m.from;
        }
      }
    }
    // 2) restore content snapshots (after paths are back)
    if (entry.files) {
      for (const [path, content] of entry.files) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.vault.modify(f, content);
      }
    }
    new Notice(tr().undone(entry.label));
    await this.refresh();
    this.updateUndoButton();
  }

  // enable or disable the undo button
  private updateUndoButton(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
  }

  // Seam handed to the render/* modules: live getters for mutable state, bound callbacks for
  // view-owned behavior. Built once and reused across renders — the getters always read current
  // state and the captured refs (app/plugin/measurer/dragged) are never reassigned.
  private cachedCtx?: ViewCtx;
  private ctx(): ViewCtx {
    if (this.cachedCtx) return this.cachedCtx;
    const self = this;
    return (this.cachedCtx = {
      app: this.app,
      plugin: this.plugin,
      measurer: this.measurer,
      dragged: this.dragged,
      get range() { return self.range; },
      get ppd() { return self.ppd; },
      get rows() { return self.rows; },
      get tasks() { return self.tasks; },
      get zoom() { return self.zoom; },
      get groupBy() { return self.groupBy; },
      get colorBy() { return self.colorBy; },
      get folder() { return self.folder; },
      get rollup() { return self.rollup; },
      get collapsed() { return self.collapsed; },
      get selectedPath() { return self.selectedPath; },
      visibleColumns: () => this.visibleColumns(),
      tableWidth: () => this.tableWidth(),
      colW: (id) => this.colW(id),
      colLabel: (id) => this.colLabel(id),
      toggleSort: (id) => this.toggleSort(id),
      autoFitColumn: (id, nth, th) => this.autoFitColumn(id, nth, th),
      setTbodyEl: (el) => { this.tbodyEl = el; },
      makeDraggableTask: (row, path) => this.makeDraggableTask(row, path),
      makeDropTarget: (row, handler) => this.makeDropTarget(row, handler),
      taskFolder: (path) => this.taskFolder(path),
      reparentTo: (s, d, p) => this.reparentTo(s, d, p),
      addTagTo: (s, tag) => this.addTagTo(s, tag),
      createTaskInFolder: (f) => this.createTaskInFolder(f),
      createSubtask: (p) => this.createSubtask(p),
      confirmDelete: (p) => this.confirmDelete(p),
      openColorMenu: (e, kind, name) => this.openColorMenu(e, kind, name),
      activateTask: (p, ev) => this.activateTask(p, ev),
      openTaskNote: (p) => this.openTaskNote(p),
      openTaskInSidebar: (p) => this.openTaskInSidebar(p),
      refresh: () => this.refresh(),
      rerender: () => this.rerender(),
      pushUndo: (l) => this.pushUndo(l),
      updateProjectProgress: (o) => this.updateProjectProgress(o),
    });
  }

  // ----- create a new task -----
  // create a 1-day task (start = end = today) in the current folder, then open it in the native sidebar view (rename via the note)
  private startInlineEdit(path: string): void {
    const row = this.tbodyEl?.querySelector(`.ogantt-tr[data-path="${CSS.escape(path)}"]`);
    const nameEl = row?.querySelector<HTMLElement>(".ogantt-task-name-label");
    if (!nameEl) return;
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }

  // Create a task in `folder` with start = end = today; returns the new file (or null).
  private async createTaskWithToday(folder: string): Promise<TFile | null> {
    const file = await createTask(this.app, folder, tr().newTaskName);
    if (!file) return null;
    const k = this.plugin.settings.keys;
    const today = dayToStr(todayIndex());
    await writeField(this.app, file.path, k.start, today);
    await writeField(this.app, file.path, k.end, today);
    return file;
  }

  // Create + refresh + start renaming inline. Shared by the toolbar button and group menus.
  private async createTaskInFolder(folderPath: string): Promise<void> {
    const file = await this.createTaskWithToday(folderPath);
    if (!file) return;
    await this.refresh();
    this.startInlineEdit(file.path);
  }

  private createNewTask(): Promise<void> {
    return this.createTaskInFolder(this.folder);
  }

  private async createSubtask(parentPath: string): Promise<void> {
    const file = await this.createTaskWithToday(this.taskFolder(parentPath));
    if (!file) return;
    const parentFile = this.app.vault.getAbstractFileByPath(parentPath);
    if (parentFile instanceof TFile) {
      const k = this.plugin.settings.keys;
      await writeField(this.app, file.path, k.parent, this.app.fileManager.generateMarkdownLink(parentFile, file.path));
    }
    await this.refresh();
    this.startInlineEdit(file.path);
  }

  // ----- drag & drop (onto a folder = detach + move; onto a task = make subtask) -----
  // make a task row draggable
  private makeDraggableTask(row: HTMLElement, path: string): void {
    row.setAttr("draggable", "true");
    row.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
  }

  // make a row a drop target (calls handler(srcPath) on drop)
  private makeDropTarget(row: HTMLElement, handler: (srcPath: string) => void): void {
    row.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault(); // allow dropping
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.addClass("is-drop-target");
    });
    row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
    row.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      row.removeClass("is-drop-target");
      const src = e.dataTransfer?.getData("text/plain");
      if (src) handler(src);
    });
  }

  // a task's folder dir ("" = vault root)
  private taskFolder(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  // set/clear parent, move subtree, re-render (undoable)
  // parentTaskPath != null → make a subtask (into that parent's folder); null → detach (to destFolder's top level)
  private async reparentTo(srcPath: string, destFolder: string, parentTaskPath: string | null): Promise<void> {
    if (srcPath === parentTaskPath) return; // not onto itself
    // cycle guard: parent must not be a descendant of src
    if (parentTaskPath && subtreePaths(this.tasks, srcPath).includes(parentTaskPath)) {
      new Notice(tr().cycleBlocked);
      return;
    }
    const pf = parentTaskPath ? this.app.vault.getAbstractFileByPath(parentTaskPath) : null;
    const parentFile = pf instanceof TFile ? pf : null;
    const name = this.tasks.find((t) => t.path === srcPath)?.name ?? srcPath;
    const res = await reparentTask(this.app, this.plugin.settings, this.tasks, srcPath, destFolder, parentFile);
    if (!res) return;
    const label = parentTaskPath ? tr().undoSubtask(name) : tr().undoDetach(name);
    this.pushUndoReparent(label, res.moves, srcPath, res.oldContent);
    const srcMove = res.moves.find((m) => m.from === srcPath);
    if (srcMove && this.selectedPath === srcPath) this.selectedPath = srcMove.to;
    await this.refresh();
  }

  // add a tag via drop (undoable; no-op if already tagged)
  private async addTagTo(srcPath: string, tag: string): Promise<void> {
    const pre = this.tasks.find((x) => x.path === srcPath);
    if (!pre || pre.tags.includes(tag)) return;
    await this.pushUndo(tr().undoAddTag(pre.name, tag));
    await addTag(this.app, srcPath, tag);
    // look up the live task (survives a background refresh)
    const live = this.tasks.find((x) => x.path === srcPath);
    if (live && !live.tags.includes(tag)) live.tags.push(tag);
    this.rerender();
  }

  // single click = open the task's note in the right sidebar (native view).
  // ignore the 2nd+ click of a double (ev.detail > 1); full editing opens in a main tab via the dblclick handler.
  private activateTask(path: string, ev: MouseEvent): void {
    if (ev.detail > 1) return;
    void this.openTaskInSidebar(path);
  }

  // open the task's note in a single, reused right-sidebar leaf — like native file navigation, no tab pile-up
  private async openTaskInSidebar(path: string): Promise<void> {
    // second click on the same task closes the sidebar
    if (this.selectedPath === path && this.noteLeaf && this.isLeafAttached(this.noteLeaf)) {
      this.noteLeaf.detach();
      this.noteLeaf = null;
      this.selectedPath = null;
      this.tbodyEl?.querySelectorAll(".ogantt-tr.is-selected").forEach((e) => e.removeClass("is-selected"));
      this.gridHost?.querySelector<SVGElement>(".ogantt-svg")?.querySelectorAll(".ogantt-row-sel").forEach((e) => e.remove());
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    // in-memory ref gone? try to recover by the persisted leaf id so the same pane survives reloads
    if (this.noteLeaf && !this.isLeafAttached(this.noteLeaf)) this.noteLeaf = null;
    if (!this.noteLeaf && this.plugin.settings.sidebarLeafId) {
      const savedId = this.plugin.settings.sidebarLeafId;
      this.app.workspace.iterateAllLeaves((l) => {
        if ((l as any).id === savedId) this.noteLeaf = l;
      });
    }
    const leaf = this.noteLeaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    // persist the leaf id so the next reload can find the same pane
    const leafId = (leaf as any).id as string | undefined;
    if (leafId && leafId !== this.plugin.settings.sidebarLeafId) {
      this.plugin.settings.sidebarLeafId = leafId;
      void this.plugin.saveSettings();
    }
    this.noteLeaf = leaf;
    await leaf.openFile(file, { active: false }); // keep focus on the Gantt
    void this.app.workspace.revealLeaf(leaf); // uncollapse the sidebar if it's collapsed
    this.markSelected(path);
  }

  // whether the leaf is still attached to the workspace
  private isLeafAttached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) found = true; });
    return found;
  }

  // update the selected-row highlight (marks the task shown in the sidebar)
  private markSelected(path: string): void {
    this.selectedPath = path;
    // table row
    this.tbodyEl?.querySelectorAll(".ogantt-tr.is-selected").forEach((e) => e.removeClass("is-selected"));
    this.tbodyEl?.querySelector(`.ogantt-tr[data-path="${CSS.escape(path)}"]`)?.addClass("is-selected");
    // timeline SVG highlight: swap the ogantt-row-sel rect to the newly selected row
    const svg = this.gridHost?.querySelector<SVGElement>(".ogantt-svg");
    if (svg) {
      svg.querySelectorAll(".ogantt-row-sel").forEach((e) => e.remove());
      const idx = this.rows.findIndex((r) => r.kind === "task" && r.task?.path === path);
      if (idx >= 0) {
        const w = (this.range.max - this.range.min + 1) * this.ppd;
        const rect = svgEl("rect", { x: 0, y: idx * ROW_H, width: w, height: ROW_H, class: "ogantt-row-sel" });
        svg.insertBefore(rect, svg.firstChild); // behind everything else
      }
    }
  }

  // double click = open the note in a new tab
  private openTaskNote(path: string): void {
    void this.app.workspace.openLinkText(path, "", "tab");
  }

  // confirm, then delete the task (to trash)
  private confirmDelete(path: string): void {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const hasChildren = this.tasks.some((x) => x.parent === path);
    new ConfirmModal(this.app, {
      title: tr().confirmDeleteTitle,
      body: tr().confirmDeleteBody(t.name),
      sub: hasChildren ? tr().confirmDeleteChildren : undefined,
      confirmText: tr().menuDelete,
      cancelText: tr().cancel,
      onConfirm: () => void (async () => {
        const ok = await deleteTask(this.app, path);
        if (!ok) return;
        // clear the selection if the deleted task was selected
        if (this.selectedPath === path) this.selectedPath = null;
        new Notice(tr().deletedNotice(t.name));
        await this.refresh();
      })(),
    }).open();
  }

}
