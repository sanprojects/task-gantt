import { ItemView, Menu, WorkspaceLeaf, setIcon, Notice, TFile, ViewStateResult, moment } from "obsidian";
import type GanttPlugin from "./main";
import { Task, Row, ZoomMode, DepType, GanttViewState, VIEW_TYPE_GANTT } from "./types";
import { WheelGestureRouter } from "./wheelGesture";
import {
  collectTasks,
  collectFolders,
  buildRows,
  createTask,
  reparentTask,
  subtreePaths,
  writeDates,
  combineDateTime,
  writeField,
  renameTask,
  deleteTask,
  addTag,
  addDependency,
  removeDependency,
  anchorStart,
  anchorEnd,
} from "./model";
import {
  DateRange,
  computeRange,
  dayIndex,
  dayToStr,
  pxPerDay,
  buildTicks,
  todayIndex,
  formatDate,
} from "./timeline";
import { t as tr } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var
import {
  ROW_H,
  HEAD_H,
  BAR_PAD,
  RESIZE_EDGE,
  MIN_PPD,
  MAX_PPD,
  FALLBACK_BAR,
  ColumnId,
  COLUMN_ORDER,
  OPTIONAL_COLUMNS,
  COLUMN_WIDTHS,
  MAX_INDENT_DEPTH,
} from "./viewConstants";
import { hashColor, tagColor, folderColor, paintTagChip } from "./color";
import { ConfirmModal } from "./confirmModal";
import { TextMeasurer, svgEl, drawBarLabel, elbowPath } from "./svg";

// 縦スクロールバーの実幅を一度だけ実測してキャッシュ（macOS のオーバーレイは 0）。
// Fit 幅の右に固定で余白を取ると、スクロールバーが細い/無い環境で隙間として残るため。
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
  private contentRange: DateRange = { min: 0, max: 0 }; // 実タスクの範囲（バッファ無し）。初期スクロール位置の算出に使う / actual task bounds (no buffer); used to place the initial scroll
  private rangeOverride: DateRange | null = null; // 無限スクロールで広げた範囲（タスク範囲と合成）/ widened range for endless scroll (merged with task bounds)
  private extending = false; // 端での範囲拡張中ガード（scroll 再入防止）/ guard while extending at an edge (prevents re-entrant scroll handling)
  private ppd = 16;
  // ホイールによる連続ズームの上書き値（null = ズームモードの固定幅に従う）/ free wheel-zoom override (null = follow the zoom mode)
  private customPpd: number | null = null;
  private wheelRAF = 0; // ホイール連打を 1 フレーム 1 再描画に束ねる / coalesce wheel bursts to one rerender per frame
  private wheelRouter = new WheelGestureRouter(); // ジェスチャ→軸（横=スクロール/縦=ズーム）の振り分け / routes a gesture to an axis (x=scroll, y=zoom)
  // In-bar label text measurer; reads the font family lazily from the grid host (set after attach).
  private measurer = new TextMeasurer(() => this.gridHost);
  private selectedPath: string | null = null;
  private folder = ""; // 表示対象フォルダ / scoped folder path
  private collapsed = new Set<string>(); // 折りたたみ中フォルダのキー / collapsed folder keys

  // 表示オプション（ビューを開いている間だけ保持）/ view options (kept while the view is open)
  private colorBy: "status" | "assignee" = "status";
  private groupBy: "folder" | "status" | "assignee" | "tag" = "folder";
  private filterAssignee = ""; // "" = すべて / all
  private filterTag = ""; // "" = すべて / all
  private hiddenStatuses = new Set<string>(); // 凡例で外したステータス（空＝全表示）/ statuses unchecked in the legend (empty = show all)
  private showEmptyFolders = true; // 空フォルダも行として表示（既定ON）/ show empty folders as rows (default on)
  private flat = false; // フラット表示（フォルダ/親子を無視し全タスク一覧）/ flat list ignoring folders & nesting
  private rollup = false; // 親タスクのバーを子孫の集約で描く（既定OFF）/ draw parent bars as a rollup of descendants (default off)
  private allFolders: string[][] = []; // スコープ配下の全フォルダ（相対セグメント）/ all folders under scope
  private optionsHost!: HTMLElement; // フィルタ/グループ/凡例の差し替え先 / options + legend container

  // 取り消し履歴：操作前のファイル内容スナップショットと/またはファイル移動(from→to の配列)
  // undo history: a pre-op content snapshot and/or file moves (array of from → to)
  private undoStack: { label: string; files?: Map<string, string>; moves?: { from: string; to: string }[] }[] = [];
  private static readonly UNDO_LIMIT = 50;

  // バーがドラッグされたか（ドラッグ直後のクリック抑止用）/ whether a bar was dragged (to suppress the trailing click)
  private dragged = new WeakMap<SVGGElement, boolean>();

  // Fit モードでペイン幅に追従するための再描画タイマー / debounce timer to re-fit in Fit mode
  private fitTimer: number | null = null;
  private lastRenderWidth = 0; // 直近に描画したときのペイン幅。タブ復帰（幅不変）での無駄な再描画を避ける / pane width at last render; skips a needless rerender when returning to the tab (width unchanged)
  private renderPending = false; // 非表示中に保留した描画があるか（表示復帰時に onResize が flush）/ a render deferred while hidden, flushed by onResize on re-show
  private zoomBtns = new Map<ZoomMode, HTMLButtonElement>(); // ズーム切替ボタン。手動ズーム時にハイライトを外すため参照を保持 / zoom buttons; kept so the active highlight can be cleared on manual zoom
  private scrollAnchorDay: number | null = null; // 直近のタイムライン左端の日付（getState のフォールバック）/ last timeline left-edge day (getState fallback when the DOM is gone)
  private pendingScrollDay: number | null = null; // 再読込から復元する左端の日付（次の rerender で適用）/ left-edge day to restore from a reload (applied on the next rerender)
  private scrollSaveTimer: number | null = null; // スクロール後にワークスペース状態を保存するデバウンスタイマー / debounce timer to persist scroll position after scrolling

  // DOM 参照 / DOM refs
  private tbodyEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private noteLeaf: WorkspaceLeaf | null = null; // タスクのノートを表示する右サイドバーの使い回しリーフ / reused right-sidebar leaf showing the task note
  private undoBtn: HTMLButtonElement | null = null;
  private projectProgressEl: HTMLElement | null = null; // ツールバー右の全体進捗表示 / overall-progress readout on the right of the toolbar

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

  // スコープ＋表示オプション/フィルタを状態として保存/復元（再読込・再起動をまたぐ）/ persist scope + view options/filters (across reloads/restarts)
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
    // 手動ズームのときは倍率も保存。Fit 以外は常にスクロール位置を保存（Fit は再フィットさせる）。
    // always persist the scroll position except in Fit (which re-fits on reload); also save the custom scale when wheel-zoomed.
    if (this.customPpd != null) s.customPpd = this.customPpd;
    const anchor = this.currentAnchorDay();
    if (anchor != null) s.scrollDay = anchor;
    return s;
  }

  // タイムライン左端の（小数）日付。再読込でスクロール位置を復元するための基準 / fractional day at the timeline's left edge, used to restore scroll across reloads
  private currentAnchorDay(): number | null {
    const main = this.gridHost?.querySelector<HTMLElement>(".ogantt-main");
    if (main && this.ppd > 0) return this.range.min + main.scrollLeft / this.ppd;
    return this.scrollAnchorDay; // DOM が無い（非表示/遅延）ときは直近のキャッシュ / fall back to the cached value when there's no DOM (hidden/deferred)
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
    // 倍率と左端位置を復元。customPpd は手動ズーム時のみ存在。scrollDay はプリセットでも復元する。
    // restore scale and scroll; customPpd exists only for wheel zoom; scrollDay is restored for presets too.
    this.customPpd = typeof state?.customPpd === "number" ? state.customPpd : null;
    this.pendingScrollDay = typeof state?.scrollDay === "number" ? state.scrollDay : null;
    await super.setState(state, result);
    if (this.gridHost) await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    await this.refresh();
    // メタデータ更新で自動再描画（ガント部のみ）/ re-render the grid when frontmatter changes
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    // ファイルの作成/削除/リネーム（フォルダ移動含む）でも自動再描画 / also re-render on create / delete / rename (incl. folder moves)
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    // Ctrl/Cmd+Z で取り消し（入力欄にフォーカス中はネイティブ undo を優先）
    // Ctrl/Cmd+Z to undo (defer to native undo while an input is focused)
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return;
      const ae = activeDocument.activeElement as HTMLElement | null;
      // テキスト編集中だけネイティブ undo を優先（time 等の入力はガント側の取り消しを通す）
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

  // Obsidian がペイン/ウィンドウのリサイズ時に呼ぶフック。Fit のみ再描画（デバウンス）
  // Obsidian calls this on pane/window resize; re-fit in Fit mode only (debounced)
  onResize(): void {
    const w = this.gridHost?.clientWidth ?? 0;
    if (w === 0) return; // まだ非表示 / still hidden
    // 非表示中に保留した描画があれば、表示に戻ったここで一度だけ実行 / flush a render that was deferred while hidden
    if (this.renderPending) { this.rerender(); return; }
    // ホイールズームで上書き中（customPpd）は再フィットしない＝再描画でスクロール位置を潰さない
    // once a wheel zoom overrides Fit (customPpd set), don't re-fit: a rerender would reset scrollLeft
    if (this.zoom !== "Fit" || this.customPpd != null) return;
    // 幅が前回描画時と同じ＝ペインが再表示されただけ（タブ復帰）。再描画しない＝内容のフルリロードを防ぐ。
    // same width as the last render = the pane was merely re-shown (tab return); skip the rerender to avoid a full content reload
    if (w === this.lastRenderWidth) return;
    if (this.fitTimer != null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.rerender(), 80);
  }

  // ツールバーは永続化、再描画はガント部だけ / persistent toolbar; only the grid re-renders
  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ogantt-board");
    this.renderToolbar(root);
    this.optionsHost = root.createDiv({ cls: "ogantt-options" }); // 中身は rerender で差し替え / repopulated on rerender
    this.gridHost = root.createDiv({ cls: "ogantt-host" });
    // 縦ホイール／2本指の上下スワイプでカーソル位置を軸に連続ズーム（横スワイプは横スクロールのまま）
    // vertical wheel / two-finger up-down swipe zooms smoothly, anchored under the cursor (horizontal swipe still scrolls)
    // passive:false で登録しないと preventDefault が無視され縦スクロールを止められない / non-passive so preventDefault can cancel the scroll
    this.registerDomEvent(this.gridHost, "wheel", (e: WheelEvent) => this.onWheelZoom(e), { passive: false });
  }

  private refreshTimer: number | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 300);
  }

  // ビューを閉じたら保留中のタイマーを止める（破棄後の再描画を防ぐ）/ stop the pending timer on close
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
    activeDocument.querySelectorAll(".ogantt-cal, .ogantt-colmenu, .ogantt-timepick").forEach((e) => e.remove()); // 開いたままのポップオーバーを掃除 / drop any open popover
  }

  // ディスクから集計し直して再描画 / re-collect from disk, then render
  async refresh(): Promise<void> {
    if (!this.gridHost) this.buildSkeleton();
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.allFolders = collectFolders(this.app, this.plugin.settings, this.folder);
    this.rerender();
  }

  // メモリ上の this.tasks から描画（ディスクは読まない）/ render from in-memory tasks (no disk read)
  // ドラッグや整列の直後、metadataCache 更新前に正しい位置を即表示するため / shows correct positions before metadataCache updates
  rerender(): void {
    this.app.workspace.requestSaveLayout(); // フィルタ等の変更を workspace 状態へ保存（デバウンス済み）/ persist filter changes to workspace state (debounced)
    if (!this.gridHost) this.buildSkeleton();
    // ペインが非表示（幅0）のときは描画を保留。Fit の ppd は幅依存なので width 0 で描くと壊れる。
    // 表示に戻った時に onResize が flush する。バックグラウンドのデータ更新で再描画が走っても無駄打ちしない。
    // defer the draw while the pane is hidden (width 0): Fit's ppd is width-derived, so drawing at 0 is wrong.
    // onResize flushes it once the pane is shown again; this also no-ops background data-change rerenders.
    if (this.gridHost.clientWidth === 0) { this.renderPending = true; return; }
    this.renderPending = false;
    this.lastRenderWidth = this.gridHost.clientWidth; // 復帰時に幅が同じなら再描画しないための基準 / baseline so a same-width re-show skips the rerender
    this.renderOptions(); // フィルタ/グループ/凡例を最新データで更新 / refresh options + legend
    this.updateProjectProgress(); // 全体進捗を最新データで更新 / refresh overall progress from current data
    this.updateZoomButtons(); // 手動ズーム時は Fit 等のハイライトを外す / drop the preset highlight while a manual zoom is active
    const view = this.processTasks(); // フィルタ＋グループ適用後 / after filter + group remap
    const compare = this.taskComparator();
    if (this.flat) {
      // フラット：フォルダも親子も無視して全タスクを1本のソート済みリストに / flat: one sorted list, no grouping/nesting
      this.rows = view.slice().sort(compare).map((task) => ({ kind: "task", group: "", depth: 0, task } as Row));
    } else {
      // フォルダグループ化＋オプションON のときだけ空フォルダもノード化 / seed empty folders only when grouping by folder and the option is on
      const folders = this.showEmptyFolders && this.groupBy === "folder" ? this.allFolders : [];
      // 親子ネストはフォルダグループ化のときだけ / nest by parent only when grouping by folder
      this.rows = buildRows(view, this.collapsed, folders, compare, this.groupBy === "folder");
    }
    this.range = this.effectiveRange(view);
    this.ppd = this.computePpd();
    const titleEl = this.contentEl.querySelector(".ogantt-title");
    if (titleEl) titleEl.setText(this.folder || "(vault root)");

    // 再描画前のスクロール位置を控える（無限スクロールで位置を保つため）/ remember the scroll position to keep it across the rerender
    const prevMain = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    const prevScroll = prevMain ? prevMain.scrollLeft : null;

    this.gridHost.empty();
    // タスクが無くても表示すべきフォルダ行があれば描画する / render if there are rows (even empty folders)
    if (this.rows.length === 0) {
      this.gridHost.createDiv({ cls: "ogantt-empty" }).setText(
        tr().emptyMessage(this.folder || "vault")
      );
      return;
    }
    const main = this.gridHost.createDiv({ cls: "ogantt-main" });
    // 端に近づいたら範囲を継ぎ足す＝無限スクロール / extend the range near the edges = endless scroll
    main.addEventListener("scroll", () => this.onTimelineScroll(main), { passive: true });
    this.renderGrid(main);
    // スクロール位置の優先順位：①再読込からの復元（左端の日付）②再描画前の値 ③初回は内容の先頭へ。
    // scroll position priority: (1) restore from a reload (left-edge day), (2) the pre-rerender value, (3) content start on first render.
    if (this.pendingScrollDay != null) {
      main.scrollLeft = Math.max(0, (this.pendingScrollDay - this.range.min) * this.ppd);
      this.pendingScrollDay = null; // 一度だけ適用 / apply once
    } else {
      main.scrollLeft = prevScroll ?? Math.max(0, (this.contentRange.min - this.range.min) * this.ppd);
    }
    this.pinTableColumn(main); // 初期スクロール位置でも左表を即固定（scroll イベント前）/ pin the left table at the initial position too (before any scroll event)
  }

  // 1 日あたりピクセルを決定。Fit はペイン幅から算出（収まらなければ最小幅で横スクロール）
  // pixels-per-day; Fit derives it from the pane width (falls back to scrolling below MIN_PPD)
  private computePpd(): number {
    // ホイールで連続ズーム中はその値を優先（モード/Fit より上）/ wheel zoom overrides the mode (and Fit)
    if (this.customPpd != null) return Math.min(MAX_PPD, Math.max(MIN_PPD, this.customPpd));
    if (this.zoom !== "Fit") return pxPerDay(this.zoom);
    // Fit はバッファ込みの range ではなくタスク実範囲（contentRange）で倍率を決める / use the actual task span (no buffer) for Fit scale
    const totalDays = Math.max(1, this.contentRange.max - this.contentRange.min + 1);
    // 1px の安全マージン：端数なしで「ぴったり」埋めると、浮動小数の誤差で scrollWidth が
    // clientWidth を僅かに超え、全幅の横スクロールバーが出る。1px 引けば確実に収まり（不可視）。
    // 1px safety margin: filling the width *exactly* lets float rounding push scrollWidth just past
    // clientWidth, which shows a full-width horizontal scrollbar. Subtracting 1px guarantees it fits (invisible).
    const avail = (this.gridHost?.clientWidth ?? 0) - this.tableWidth() - scrollbarWidth() - 1;
    if (avail <= 0) return pxPerDay("Week"); // まだレイアウト前 / not laid out yet
    // 端数で割る（floor しない）＝ totalDays*ppd が avail にほぼ一致し、右端に目立つ隙間が出ない。
    // MIN_PPD を下回るときだけ最小幅にして横スクロールへ。
    // use a fractional px/day (no floor) so totalDays*ppd ≈ avail — no visible gap on the right.
    // only fall back to MIN_PPD (with horizontal scroll) when it can't fit.
    const ppd = avail / totalDays;
    return ppd >= MIN_PPD ? ppd : MIN_PPD;
  }

  // 表示範囲：タスク範囲＋前後バッファ（無限スクロール用に override で広げられる）。Fit はタスクを丸ごと収めるので拡張しない
  // visible range: task bounds + a buffer each side (widened via override for endless scroll); Fit fits all tasks, so it gets no buffer
  private effectiveRange(view: Task[]): DateRange {
    const base = computeRange(view);
    this.contentRange = base;
    if (this.zoom === "Fit" && this.customPpd == null) return base;
    const ppd = this.customPpd ?? pxPerDay(this.zoom);
    const vpDays = Math.ceil((this.gridHost?.clientWidth ?? 800) / Math.max(1, ppd));
    const pad = Math.max(90, vpDays * 2); // 可視幅の約2倍を前後に（最低90日）/ ~2 viewports each side (min 90 days)
    let min = base.min - pad;
    let max = base.max + pad;
    if (this.rangeOverride) {
      min = Math.min(min, this.rangeOverride.min);
      max = Math.max(max, this.rangeOverride.max);
    }
    return { min, max };
  }

  // 左の表（ヘッダ＋本体）を横スクロールに追従させて固定する。CSS グリッドでは sticky-left がグリッド領域にクランプされ効かないため transform で固定
  // pin the left table (header + body) to the horizontal scroll; sticky-left is clamped to the grid area in a CSS grid, so we use a transform instead
  private pinTableColumn(main: HTMLElement): void {
    const x = `translateX(${main.scrollLeft}px)`;
    const corner = main.querySelector<HTMLElement>(".ogantt-corner");
    const body = main.querySelector<HTMLElement>(".ogantt-tbody");
    if (corner) corner.style.transform = x;
    if (body) body.style.transform = x;
  }

  // 端に近づいたら範囲を継ぎ足して無限スクロールにする / extend the range near an edge for endless scrolling
  private onTimelineScroll(main: HTMLElement): void {
    this.pinTableColumn(main); // まず左表を追従させる / keep the left table pinned first
    if (this.ppd > 0) this.scrollAnchorDay = this.range.min + main.scrollLeft / this.ppd; // 左端の日付をキャッシュ（再読込での復元用）/ cache the left-edge day for restore across reloads
    // スクロール後300msでワークスペース状態を保存（再読込でスクロール位置を復元するため）/ save workspace state 300ms after scrolling so position survives reload
    if (this.scrollSaveTimer != null) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => this.app.workspace.requestSaveLayout(), 300);
    if (this.extending) return;
    if (this.zoom === "Fit" && this.customPpd == null) return; // Fit は全体表示なので拡張しない / Fit shows everything; nothing to extend
    const threshold = main.clientWidth; // 1画面ぶん手前で継ぎ足す / extend one viewport before the edge
    const maxScroll = main.scrollWidth - main.clientWidth;
    const chunk = Math.max(90, Math.ceil(main.clientWidth / Math.max(1, this.ppd)));
    if (main.scrollLeft <= threshold) this.extendRange("left", chunk, main);
    else if (main.scrollLeft >= maxScroll - threshold) this.extendRange("right", chunk, main);
  }

  // 範囲を chunk 日だけ片側へ広げて再描画。左拡張は内容が右へずれるのでスクロール位置を補正
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
      m.scrollLeft = side === "left" ? before + chunk * this.ppd : before;
      this.pinTableColumn(m); // 新しいスクロール位置に合わせて左表を即固定 / re-pin the left table at the new scroll position
    }
    this.extending = false;
  }

  // ホイール／トラックパッドのジェスチャ。軸の判定は WheelGestureRouter に委譲（縦=ズーム / 横=横スクロール）。
  // wheel/trackpad gesture; axis decision is delegated to WheelGestureRouter (vertical = zoom, horizontal = scroll).
  private onWheelZoom(e: WheelEvent): void {
    const main = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    // 左の固定テーブル列の上ではズームしない＝ブラウザのネイティブ縦スクロールで行を送れる
    // （タスクが多くて縦スクロールが出たとき、ここからスクロールできる）。
    // over the pinned left table column, don't hijack the wheel — let the browser scroll the rows
    // natively (so a long task list is scrollable). Zoom/h-scroll apply over the timeline only.
    if (e.clientX - rect.left < this.tableWidth()) {
      this.wheelRouter.reset(); // タイムラインに戻ったとき軸状態が混ざらないように / clear axis state so it doesn't carry over
      return; // preventDefault しない＝ネイティブスクロール / no preventDefault: native scroll handles it
    }
    const axis = this.wheelRouter.route(e);
    if (axis == null) {
      // まだ方向を判定中＝既定スクロールを止めて次イベントを待つ / still deciding: swallow the default scroll and wait
      e.preventDefault();
      return;
    }
    if (axis === "x") {
      // 横スワイプ＝タイムライン横スクロールのみ。縦成分は無視 / horizontal swipe scrolls the timeline only; vertical component ignored
      e.preventDefault();
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * main.clientWidth : e.deltaX;
      // Fit 中は全体が収まりスクロール余地が無い。手動で横スワイプしたら Fit を解除し現在の倍率を固定（customPpd）
      // in Fit everything fits; a manual horizontal swipe exits Fit by pinning the current scale (customPpd) so buffers get added.
      if (this.zoom === "Fit" && this.customPpd == null) {
        const before = main.scrollLeft;
        this.customPpd = this.ppd;
        this.rerender();
        const m = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
        if (!m) return;
        const leftBuffer = (this.contentRange.min - this.range.min) * this.ppd;
        m.scrollLeft = before + leftBuffer + dx;
        this.pinTableColumn(m);
        return;
      }
      main.scrollLeft += dx;
      return;
    }
    // 縦スワイプ＝カーソル下の日付を固定したまま連続ズーム / vertical swipe = smooth zoom anchored under the cursor
    e.preventDefault();
    const tableW = this.tableWidth();
    const screenX = e.clientX - rect.left; // ビューポート内のカーソル x / cursor x within the pane
    // カーソル下の（小数）日付。タイムラインは固定列の右から始まる / fractional day under the cursor (timeline starts after the sticky table)
    const dayUnder = this.range.min + (screenX + main.scrollLeft - tableW) / this.ppd;
    // deltaMode を px に正規化（マウスは行/ページ単位、トラックパッドは px）/ normalize deltaMode to px (mouse: lines/pages, trackpad: px)
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * rect.height : e.deltaY;
    // 指数スケールで等比ズーム＝どの倍率でも体感が一定 / exponential step keeps the feel constant at any scale
    const next = Math.min(MAX_PPD, Math.max(MIN_PPD, this.ppd * Math.exp(-dy * 0.0015)));
    if (next === this.ppd && this.customPpd != null) return; // 端で頭打ち / clamped at a limit
    this.customPpd = next;
    // rerender は縦スクロール位置を失う。ズームは縦位置を変えないので、再描画前の scrollTop を保持して戻す。
    // rerender loses the vertical scroll; zoom shouldn't move it, so keep scrollTop and restore it after.
    const topBefore = main.scrollTop;
    // 1 フレームにつき 1 再描画。最新のカーソル軸でスクロール位置を補正して固定する。
    // one rerender per frame; after it, fix scrollLeft so dayUnder stays under the cursor.
    if (this.wheelRAF) return;
    this.wheelRAF = requestAnimationFrame(() => {
      this.wheelRAF = 0;
      this.rerender();
      const m = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
      if (m) {
        m.scrollLeft = tableW + (dayUnder - this.range.min) * this.ppd - screenX;
        m.scrollTop = topBefore; // 縦位置を維持＝表が上に飛ばない / keep the vertical position so the table doesn't jump up
        this.pinTableColumn(m); // ズーム後のスクロール位置に合わせて左表を即固定 / re-pin the left table after the zoom adjusts scroll
      }
    });
  }

  // ----- テーブル列 / table columns -----
  // 表示中の列（name は常時、その他は設定の visibleColumns に従う）/ visible columns (name always; rest per settings)
  private visibleColumns(): ColumnId[] {
    const vis = new Set(this.plugin.settings.visibleColumns ?? []);
    return COLUMN_ORDER.filter((id) => id === "name" || vis.has(id));
  }
  // 表全体の幅（表示中の列幅の合計）/ total table width (sum of visible column widths)
  private tableWidth(): number {
    return this.visibleColumns().reduce((w, id) => w + this.colW(id), 0);
  }

  // 列の実効幅（ユーザー上書き > 既定）/ effective column width (user override > default)
  private colW(id: ColumnId): number {
    return this.plugin.settings.columnWidths[id] ?? COLUMN_WIDTHS[id];
  }

  // 列幅を内容に合わせて自動フィット（グリップのWクリック）。一時的に max-content にして実測する
  // auto-fit a column to its content (grip double-press): measure by temporarily sizing cells to max-content
  private autoFitColumn(id: ColumnId, nth: number, th: HTMLElement): void {
    const cells: HTMLElement[] = [th];
    this.tbodyEl
      ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
      .forEach((el) => cells.push(el));
    // 計測中はインライン幅を外して計測用クラスを付与（!important を使わないため）
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
    void this.plugin.saveSettings(); // 保存（ビューも再描画される）/ persist (views refresh)
  }
  // 列ヘッダのラベル / column header label
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
  // 現在のソート設定からタスク比較関数を作る / build a task comparator from the current sort settings
  private taskComparator(): (a: Task, b: Task) => number {
    const by = this.plugin.settings.sortBy as ColumnId;
    const dir = this.plugin.settings.sortDir === "desc" ? -1 : 1;
    // ステータスは設定の定義順（アルファベット順ではない）/ status sorts by the configured order, not alphabetically
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

  // 列ヘッダクリックでソート列/方向を切替えて永続化 / clicking a header toggles sort column/direction (persisted)
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

  // 列の表示/非表示を切替えて永続化 / toggle a column's visibility and persist
  private setColumnVisible(id: ColumnId, on: boolean): void {
    const set = new Set(this.plugin.settings.visibleColumns ?? []);
    if (on) set.add(id);
    else set.delete(id);
    this.plugin.settings.visibleColumns = OPTIONAL_COLUMNS.filter((c) => set.has(c)); // マスター順を維持 / keep master order
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 列の出し分けポップオーバー（チェックボックス）/ column-visibility popover (checkboxes)
  private openColumnMenu(anchor: HTMLElement): void {
    activeDocument.querySelectorAll(".ogantt-colmenu").forEach((e) => e.remove());
    const menu = activeDocument.body.createDiv({ cls: "ogantt-colmenu" });
    for (const id of OPTIONAL_COLUMNS) {
      const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
      const cb = item.createEl("input", { type: "checkbox" });
      cb.checked = (this.plugin.settings.visibleColumns ?? []).includes(id);
      item.createSpan({ text: this.colLabel(id) });
      cb.addEventListener("change", () => this.setColumnVisible(id, cb.checked));
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    const close = () => {
      menu.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!menu.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);
  }

  // ----- ツールバー / toolbar -----
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ogantt-toolbar" });
    bar.createSpan({ cls: "ogantt-title", text: this.plugin.settings.rootFolder || "(vault root)" });
    // 新規タスク追加（アイコン＋ラベル）/ add a new task (icon + label)
    const add = bar.createEl("button", { cls: "ogantt-add" });
    setIcon(add, "plus");
    add.createSpan({ cls: "ogantt-add-label", text: tr().newTaskName });
    add.setAttr("aria-label", tr().newTaskAria);
    add.onclick = () => void this.createNewTask();
    // 以降のコントロールは「＋」の右に左詰めで並べる（詳細パネルで隠れないように）
    // keep the following controls left-packed next to "+" (so the detail panel can't hide them)
    // 今日へスクロール / scroll to today
    const todayBtn = bar.createEl("button", { cls: "ogantt-today-btn", text: tr().today });
    todayBtn.onclick = () => this.scrollToToday();
    this.zoomBtns.clear();
    (["Day", "Week", "Month", "Fit"] as ZoomMode[]).forEach((z) => {
      const btn = bar.createEl("button", { text: z });
      this.zoomBtns.set(z, btn);
      btn.onclick = () => {
        this.zoom = z; // ppd は rerender 内の computePpd() が決める / ppd is set by computePpd() in rerender
        this.customPpd = null; // モードを選んだらホイールズームの上書きを解除 / picking a mode drops the wheel-zoom override
        void this.refresh(); // refresh→rerender→updateZoomButtons がハイライトを更新 / the rerender refreshes the active highlight
      };
    });
    this.updateZoomButtons();
    // 取り消しボタン / undo button
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

    // 末尾の伸縮スペーサー（コントロールを左詰めに保つ）/ trailing spacer keeps controls left-packed
    bar.createDiv({ cls: "ogantt-spacer" });

    // 全体進捗（期間で重み付けした平均。リサイズ中はライブ更新）/ overall progress (duration-weighted mean; updates live during resize)
    const prog = bar.createDiv({ cls: "ogantt-project-progress" });
    const track = prog.createDiv({ cls: "ogantt-project-progress-track" });
    track.createDiv({ cls: "ogantt-project-progress-fill" });
    prog.createSpan({ cls: "ogantt-project-progress-val" });
    this.projectProgressEl = prog;
    this.updateProjectProgress();
  }

  // ズームボタンの選択ハイライトを現在状態に同期。手動ズーム（customPpd）中はどのプリセットも非アクティブ
  // sync the zoom buttons' active highlight; while a manual zoom (customPpd) is active, no preset is highlighted
  private updateZoomButtons(): void {
    this.zoomBtns.forEach((btn, z) => btn.toggleClass("is-active", this.customPpd == null && z === this.zoom));
  }

  // タスクの期間（日数。日付が無ければ 0＝重み無し）/ a task's span in days (0 = no dates → no weight)
  private taskDays(t: Task): number {
    const s = anchorStart(t);
    if (!s) return 0;
    return Math.max(1, dayIndex(anchorEnd(t) ?? s) - dayIndex(s) + 1);
  }

  // 全体進捗＝Σ(日数×進捗)/Σ(日数)。override でドラッグ中タスクの日数を差し替え、ライブ計算する
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

  // ----- 表示オプション（グループ/色分け/フィルタ）＋凡例 / view options + legend -----
  // データに依存する（担当者一覧など）ので rerender 毎に作り直す / rebuilt each rerender (depends on data)
  private renderOptions(): void {
    const host = this.optionsHost;
    host.empty();
    const statuses = this.plugin.settings.statuses;
    const none = tr().noneLabel;
    // 現在のフォルダ内に実在する担当者一覧 / assignees actually present in the current folder
    const assignees = [...new Set(this.tasks.map((t) => t.assignee).filter((a): a is string => !!a))].sort();
    // 現在のフォルダ内に実在するタグ一覧 / tags actually present in the current folder
    const tags = [...new Set(this.tasks.flatMap((t) => t.tags))].sort();

    const makeSelect = (icon: string, label: string, value: string, opts: [string, string][], on: (v: string) => void): void => {
      const wrap = host.createDiv({ cls: "ogantt-opt" });
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      ic.setAttr("aria-label", label); // アイコンの意味をツールチップで補助 / tooltip explains the icon
      const sel = wrap.createEl("select");
      for (const [val, text] of opts) {
        const o = sel.createEl("option", { text, value: val });
        if (val === value) o.selected = true;
      }
      sel.addEventListener("change", () => on(sel.value));
    };

    // チェックボックス（ラベル全体クリックで切替）/ checkbox (the whole label toggles it)
    const makeCheckbox = (icon: string, label: string, checked: boolean, on: (v: boolean) => void): void => {
      const wrap = host.createEl("label", { cls: "ogantt-opt ogantt-opt-check" });
      const cb = wrap.createEl("input", { type: "checkbox" });
      cb.checked = checked;
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      wrap.createSpan({ text: label });
      cb.addEventListener("change", () => on(cb.checked));
    };

    // 列の表示/非表示（歯車）＝オプション行の一番左 / column visibility (gear) — leftmost of the options row
    const colBtn = host.createEl("button", { cls: "ogantt-opt-gear clickable-icon" });
    setIcon(colBtn, "settings");
    colBtn.setAttr("aria-label", tr().optColumns);
    colBtn.onclick = () => this.openColumnMenu(colBtn);

    // ── 表示の組み立て（グループ化・色分け）/ layout (group + color) ──
    // グループ化 / group by
    makeSelect(
      "layers",
      tr().optGroupLabel,
      this.groupBy,
      [["folder", tr().optGroupFolder], ["status", tr().fieldStatus], ["assignee", tr().fieldAssignee], ["tag", tr().fieldTags]],
      (v) => { this.groupBy = v as typeof this.groupBy; this.collapsed.clear(); this.rerender(); }
    );
    // 色分け / color by
    makeSelect(
      "palette",
      tr().optColorLabel,
      this.colorBy,
      [["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
      (v) => {
        this.colorBy = v as typeof this.colorBy;
        // ステータス凡例フィルタはステータス色分け時のみ操作可能なので、外れたら解除して不可視フィルタを残さない / the status legend-filter is only operable while coloring by status, so clear it otherwise to avoid an invisible filter
        if (this.colorBy !== "status") this.hiddenStatuses.clear();
        this.rerender();
      }
    );

    // ── 絞り込み（フィルタ）と視覚的に分ける区切り / divider before filters ──
    host.createDiv({ cls: "ogantt-opt-divider" });

    // 担当者で絞り込み / filter by assignee
    makeSelect(
      "user",
      tr().fieldAssignee,
      this.filterAssignee,
      [["", tr().filterAll], ...assignees.map((a) => [a, a] as [string, string])],
      (v) => { this.filterAssignee = v; this.rerender(); }
    );
    // タグで絞り込み（タグが1つも無ければ非表示）/ filter by tag (hidden when no tags exist)
    if (tags.length > 0) {
      makeSelect(
        "tag",
        tr().fieldTags,
        this.filterTag,
        [["", tr().filterAll], ...tags.map((tg) => [tg, tg] as [string, string])],
        (v) => { this.filterTag = v; this.rerender(); }
      );
    }
    // 空フォルダ表示の切替（フォルダグループ化時のみ・フラットでは無効）/ show-empty-folders (folder grouping only; off in flat)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("folder", tr().optShowEmpty, this.showEmptyFolders, (v) => {
        this.showEmptyFolders = v;
        this.rerender();
      });
    }
    // ロールアップの切替（親タスクのバーを子孫の集約で描く・フォルダグループ化時のみ）/ rollup (folder grouping only)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("git-merge", tr().optRollup, this.rollup, (v) => {
        this.rollup = v;
        this.rerender();
      });
    }
    // フラット表示の切替（フォルダ/親子を無視した全タスク一覧）/ flat view (all tasks, no grouping/nesting)
    makeCheckbox("list", tr().optFlat, this.flat, (v) => {
      this.flat = v;
      this.rerender();
    });

    // 凡例（色分けの基準を説明）/ legend explaining the current color basis
    const legend = host.createDiv({ cls: "ogantt-legend" });
    if (this.colorBy === "status") {
      // 凡例＝ステータスのトグルフィルタ（既定で全選択、クリックで外す）/ legend doubles as a status toggle-filter (all on by default, click to drop)
      for (const s of statuses) {
        const on = !this.hiddenStatuses.has(s.id);
        this.legendChip(legend, s.color, s.label, () => {
          if (this.hiddenStatuses.has(s.id)) this.hiddenStatuses.delete(s.id);
          else this.hiddenStatuses.add(s.id);
          this.rerender();
        }, on);
      }
    } else {
      for (const a of assignees) this.legendChip(legend, hashColor(a), a);
      if (this.tasks.some((t) => !t.assignee)) this.legendChip(legend, FALLBACK_BAR, none);
    }
  }

  private legendChip(parent: HTMLElement, color: string, label: string, onToggle?: () => void, on = true): void {
    const chip = parent.createDiv({ cls: "ogantt-legend-chip" });
    const sw = chip.createSpan({ cls: "ogantt-legend-swatch" });
    sw.style.background = color;
    chip.createSpan({ text: label });
    if (onToggle) {
      chip.classList.add("is-toggle");
      chip.classList.toggle("is-off", !on);
      chip.setAttr("role", "checkbox");
      chip.setAttr("aria-checked", String(on));
      chip.setAttr("tabindex", "0");
      chip.onclick = onToggle;
      chip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } };
    }
  }

  // タグ/フォルダ色の上書きを設定（color=null でリセット＝自動へ）/ set or clear a tag/folder color override (null = reset to auto)
  private setColorOverride(kind: "tag" | "folder", name: string, color: string | null): void {
    const arr = kind === "tag" ? this.plugin.settings.tagColors : this.plugin.settings.folderColors;
    const i = arr.findIndex((c) => c.name === name);
    if (color == null) {
      if (i >= 0) arr.splice(i, 1); // リセット＝上書きを削除 / reset = drop the override
    } else if (i >= 0) {
      arr[i].color = color;
    } else {
      arr.push({ name, color });
    }
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 右クリックの色メニュー（変更＝ネイティブピッカー／リセット＝自動）/ right-click color menu (change → native picker; reset → auto)
  private openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void {
    const current = kind === "tag" ? tagColor(this.plugin.settings, name) : folderColor(this.plugin.settings, name);
    const m = new Menu();
    m.addItem((i) => i.setTitle(tr().menuChangeColor).setIcon("palette").onClick(() => {
      // 隠し input[type=color] を生成してネイティブピッカーを開く / spawn a hidden color input to open the native picker
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

  // フィルタ→グループ再マッピングを適用したタスク列を返す / tasks after filter + group remap
  private processTasks(): Task[] {
    let list = this.tasks;
    if (this.hiddenStatuses.size) list = list.filter((t) => !this.hiddenStatuses.has(t.status ?? ""));
    if (this.filterAssignee) list = list.filter((t) => (t.assignee ?? "") === this.filterAssignee);
    if (this.filterTag) list = list.filter((t) => t.tags.includes(this.filterTag));
    // フラットはグループを無視＝再マッピング不要（タグ複製で重複行が出るのも防ぐ）/ flat ignores groups: skip remap (also avoids tag-duplicated rows)
    if (this.groupBy === "folder" || this.flat) return list;
    const none = tr().noneLabel;
    // タグは多値＝1タスクを各タグのグループへ複製（タグ無しは (なし)）/ tags are multi-valued: duplicate a task into each tag's group
    if (this.groupBy === "tag") {
      const out: Task[] = [];
      for (const t of list) {
        if (t.tags.length === 0) out.push({ ...t, groups: [none] });
        else for (const tag of t.tags) out.push({ ...t, groups: [tag] });
      }
      return out;
    }
    // groups を単一の合成グループへ差し替えて既存の buildRows を再利用 / remap groups to reuse buildRows
    const statusLabel = new Map(this.plugin.settings.statuses.map((s) => [s.id, s.label]));
    return list.map((t) => {
      const key =
        this.groupBy === "status"
          ? t.status ? statusLabel.get(t.status) ?? t.status : none
          : t.assignee || none;
      return { ...t, groups: [key] };
    });
  }

  // 今日の線が中央に来るよう横スクロール / scroll horizontally so the today marker is centered
  private scrollToToday(): void {
    const main = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    const todayLine = main?.querySelector<SVGElement>(".ogantt-today");
    if (!main || !todayLine) return; // 今日が範囲外＝線が無い / no marker when today is out of range
    const mb = main.getBoundingClientRect();
    const tb = todayLine.getBoundingClientRect();
    main.scrollLeft += tb.left - mb.left - main.clientWidth / 2;
  }

  // ----- 取り消し（Undo）-----
  // 操作前に現在のタスクファイル内容を控える / snapshot current task files before an op
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

  // 親変更/移動を取り消し履歴へ（戻すとき：移動を逆再生→src の旧内容を復元）/ record a reparent/move
  private pushUndoReparent(label: string, moves: { from: string; to: string }[], srcOrigPath: string, oldContent: string): void {
    this.undoStack.push({ label, moves, files: new Map([[srcOrigPath, oldContent]]) });
    if (this.undoStack.length > GanttView.UNDO_LIMIT) this.undoStack.shift();
    this.updateUndoButton();
  }

  // 直近の操作を取り消す（移動の巻き戻し→内容スナップショット復元）/ revert the most recent op (undo moves, then restore content)
  private async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToUndo);
      return;
    }
    // 1) 移動を逆順に巻き戻す（to→from へリネーム）/ undo moves in reverse (rename to → from)
    if (entry.moves) {
      for (const m of [...entry.moves].reverse()) {
        const f = this.app.vault.getAbstractFileByPath(m.to);
        if (f instanceof TFile) {
          await this.app.fileManager.renameFile(f, m.from);
          if (this.selectedPath === m.to) this.selectedPath = m.from;
        }
      }
    }
    // 2) 内容スナップショットを書き戻す（パスが元に戻った後）/ restore content snapshots (after paths are back)
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

  // 取り消しボタンの有効/無効を更新 / enable or disable the undo button
  private updateUndoButton(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
  }

  // ----- 表＋タイムラインを 1 つの CSS グリッドで（sticky で行を揃える）-----
  // ----- table + timeline in one CSS grid; sticky heads/left column keep rows aligned -----
  private renderGrid(main: HTMLElement): void {
    const totalDays = this.range.max - this.range.min + 1;
    const width = totalDays * this.ppd;
    const bodyH = this.rows.length * ROW_H;

    const cols = this.visibleColumns();
    const grid = main.createDiv({ cls: "ogantt-grid" });
    grid.style.gridTemplateColumns = `${this.tableWidth()}px ${width}px`;
    grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;

    // 行ループ内ではローカル変数 tr（行要素）が i18n の tr() を隠すため、先に文言を退避
    // the row var `tr` shadows the i18n tr() inside the loop, so grab strings up front
    const strings = tr();

    // (1) 左上の角＝表ヘッダー（表示中の列を並べる・クリックでソート）/ top-left corner = header (click to sort)
    const corner = grid.createDiv({ cls: "ogantt-corner" });
    for (const id of cols) {
      const th = corner.createDiv({ cls: "ogantt-th ogantt-th-sortable" + (id === "name" ? " ogantt-th-name" : "") });
      if (id !== "name") th.style.width = `${this.colW(id)}px`;
      th.createSpan({ text: this.colLabel(id) });
      // アクティブなソート列に ↑/↓ を表示 / show ↑/↓ on the active sort column
      if (this.plugin.settings.sortBy === id) {
        th.createSpan({ cls: "ogantt-sort-arrow", text: this.plugin.settings.sortDir === "asc" ? "↑" : "↓" });
      }
      th.onclick = () => this.toggleSort(id);
      // 右端グリップ：ドラッグ＝列幅変更（永続化）、素早い2回押し＝内容に合わせて自動フィット
      // right-edge grip: drag to resize the column (persisted), quick double-press auto-fits to content
      const grip = th.createDiv({ cls: "ogantt-col-grip" });
      grip.addEventListener("click", (e) => e.stopPropagation()); // ソートを抑止 / don't toggle sort
      let lastDown = 0;
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nth = cols.indexOf(id) + 1;
        if (e.timeStamp - lastDown < 400) {
          // Wクリック判定（pointerdown の preventDefault で dblclick が来ない環境があるため自前判定）
          // manual double-press detection (dblclick may be suppressed by preventDefault on pointerdown)
          lastDown = 0;
          this.autoFitColumn(id, nth, th);
          return;
        }
        lastDown = e.timeStamp;
        grip.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = this.colW(id);
        let moved = false;
        const onMove = (ev: PointerEvent) => {
          moved = true;
          const w = Math.max(40, Math.round(startW + ev.clientX - startX));
          this.plugin.settings.columnWidths[id] = w;
          // ドラッグ中は再描画せず幅だけ反映 / live-apply widths without a full re-render
          grid.style.gridTemplateColumns = `${this.tableWidth()}px ${width}px`;
          if (id !== "name") {
            th.style.width = `${w}px`;
            this.tbodyEl
              ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
              .forEach((el) => (el.style.width = `${w}px`));
          }
        };
        const onUp = () => {
          grip.removeEventListener("pointermove", onMove);
          // 実際に動かしたときだけ保存（単押しでDOMを作り直さない＝2回押し判定を生かす）
          // save only after an actual drag (a plain press doesn't re-render, keeping double-press alive)
          if (moved) void this.plugin.saveSettings();
        };
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp, { once: true });
      });
    }

    // (2) 日付軸 / date axis
    // Fit は算出した ppd から目盛り粒度を選ぶ / in Fit, pick tick granularity from the computed ppd
    const tickZoom: ZoomMode =
      this.zoom !== "Fit" ? this.zoom : this.ppd >= 24 ? "Day" : this.ppd >= 10 ? "Week" : "Month";
    const axis = grid.createDiv({ cls: "ogantt-axis" });
    for (const tick of buildTicks(this.range, tickZoom, this.ppd)) {
      const t = axis.createDiv({ cls: "ogantt-tick" + (tick.major ? " is-major" : "") });
      t.style.left = `${tick.x}px`;
      t.setText(tick.label);
    }

    // (3) 表の本体 / table body
    const body = grid.createDiv({ cls: "ogantt-tbody" });
    this.tbodyEl = body;
    for (const row of this.rows) {
      const tr = body.createDiv({ cls: "ogantt-tr" });
      tr.style.height = `${ROW_H}px`;
      const indent = 8 + Math.min(row.depth, MAX_INDENT_DEPTH) * 16; // 入れ子インデント（上限あり）/ nesting indent (capped)
      if (row.kind === "group") {
        tr.addClass("is-group");
        const isCollapsed = row.key != null && this.collapsed.has(row.key);
        const g = tr.createDiv({ cls: "ogantt-td-group" });
        g.style.paddingLeft = `${indent}px`;
        const chev = g.createSpan({ cls: "ogantt-chevron" });
        setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
        const ic = g.createSpan({ cls: "ogantt-folder-icon" });
        // タググループはタグアイコン、それ以外はフォルダ / a tag icon for tag groups, folder otherwise
        setIcon(ic, this.groupBy === "tag" ? "tag" : isCollapsed ? "folder" : "folder-open");
        // 見出しアイコンに色（フォルダ＝フォルダ色、タグ＝タグ色。(なし) は既定色のまま）
        // tint the heading icon (folder color / tag color; leave the (none) group default)
        if (this.groupBy === "folder" && row.key != null) ic.style.color = folderColor(this.plugin.settings, row.group);
        else if (this.groupBy === "tag" && row.group !== strings.noneLabel) ic.style.color = tagColor(this.plugin.settings, row.group);
        g.createSpan({ text: row.group });
        // 見出しを右クリック＝色を変更（フォルダ／タグ。(なし) は除く）/ right-click a heading to change its color
        if (this.groupBy === "folder" && row.key != null) {
          g.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const folderPath = this.folder ? `${this.folder}/${row.key}` : (row.key ?? "");
            const m = new Menu();
            m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void this.createTaskInFolder(folderPath)));
            m.addSeparator();
            m.addItem((i) => i.setTitle(strings.menuChangeColor).setIcon("palette").onClick(() => this.openColorMenu(e, "folder", row.group)));
            m.showAtMouseEvent(e);
          });
        } else if (this.groupBy === "tag" && row.group !== strings.noneLabel) {
          g.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const m = new Menu();
            m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void this.createTaskInFolder(this.folder)));
            m.addSeparator();
            m.addItem((i) => i.setTitle(strings.menuChangeColor).setIcon("palette").onClick(() => this.openColorMenu(e, "tag", row.group)));
            m.showAtMouseEvent(e);
          });
        } else if (row.kind === "group") {
          g.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const m = new Menu();
            m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void this.createTaskInFolder(this.folder)));
            m.showAtMouseEvent(e);
          });
        }
        tr.onclick = () => {
          if (row.key == null) return;
          if (this.collapsed.has(row.key)) this.collapsed.delete(row.key);
          else this.collapsed.add(row.key);
          void this.refresh();
        };
        // フォルダグループへドロップ＝親を解除してそのフォルダのトップレベルへ / drop onto a folder = detach + move to its top level
        if (this.groupBy === "folder" && row.key != null) {
          const dest = this.folder ? `${this.folder}/${row.key}` : row.key;
          this.makeDropTarget(tr, (src) => void this.reparentTo(src, dest, null));
        }
        // タググループへドロップ＝そのタグを付与（(なし) グループは対象外）/ drop onto a tag group = add that tag (skip the (none) group)
        if (this.groupBy === "tag" && row.key != null && row.group !== strings.noneLabel) {
          const tag = row.key;
          this.makeDropTarget(tr, (src) => void this.addTagTo(src, tag));
        }
      } else {
        const t = row.task!;
        tr.setAttr("data-path", t.path);
        if (t.path === this.selectedPath) tr.addClass("is-selected");
        // 表示中の列を順に描画 / render each visible column
        for (const id of cols) {
          if (id === "name") {
            const nameTd = tr.createDiv({ cls: "ogantt-td ogantt-td-name" });
            nameTd.style.paddingLeft = `${indent}px`;
            // シェブロン枠は常に確保＝親でも単独タスクでも名前位置を揃える
            // always reserve the chevron slot so parents and standalone tasks align
            const chev = nameTd.createSpan({ cls: "ogantt-task-chevron" });
            if (row.hasChildren && row.key != null) {
              const key = row.key;
              setIcon(chev, this.collapsed.has(key) ? "chevron-right" : "chevron-down");
              chev.addClass("is-clickable");
              chev.addEventListener("click", (e) => {
                e.stopPropagation(); // 行クリック（詳細を開く）を抑止 / don't open the detail panel
                if (this.collapsed.has(key)) this.collapsed.delete(key);
                else this.collapsed.add(key);
                void this.refresh();
              });
            }
            {
              const nameEl = nameTd.createSpan({ cls: "ogantt-task-name-label" });
              nameEl.contentEditable = "true";
              nameEl.spellcheck = false;
              nameEl.textContent = t.name;
              // prevent row-level click/dblclick/drag from firing while editing the name
              nameEl.addEventListener("pointerdown", (e) => e.stopPropagation());
              nameEl.addEventListener("click", (e) => e.stopPropagation());
              nameEl.addEventListener("dblclick", (e) => e.stopPropagation());
              let committed = false;
              const task = t;
              const commit = async () => {
                if (committed) return;
                committed = true;
                const newName = (nameEl.textContent ?? "").trim();
                if (newName && newName !== task.name) {
                  task.name = newName;
                  await renameTask(this.app, task.path, newName);
                } else if (!newName) {
                  nameEl.textContent = task.name; // восстановить если стёрли / restore if cleared
                }
                committed = false; // сброс чтобы повторный blur мог работать / reset so subsequent blurs work
              };
              nameEl.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
                else if (e.key === "Escape") { e.preventDefault(); nameEl.textContent = task.name; nameEl.blur(); }
                e.stopPropagation();
              });
              nameEl.addEventListener("blur", () => void commit());
            }
            // タイトル右クリック＝削除メニュー / right-click the title = delete menu
            nameTd.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              const m = new Menu();
              m.addItem((i) => i.setTitle(strings.menuAddSubtask).setIcon("plus-circle").onClick(() => void this.createSubtask(t.path)));
              m.addItem((i) => i.setTitle(strings.menuDelete).setIcon("trash-2").onClick(() => this.confirmDelete(t.path)));
              m.showAtMouseEvent(e);
            });
          } else {
            const td = tr.createDiv({ cls: "ogantt-td" });
            td.style.width = `${this.colW(id)}px`;
            this.renderCell(td, row, id);
          }
        }
        // シングルクリック＝詳細パネル、ダブルクリック＝ノートを新規タブで（バーと同じ挙動）
        // single click = detail panel; double click = open the note in a new tab (same as the bars)
        tr.addEventListener("click", (ev) => this.activateTask(t.path, ev));
        tr.addEventListener("dblclick", () => this.openTaskNote(t.path));
        if (this.groupBy === "folder") {
          this.makeDraggableTask(tr, t.path);
          // タスク行へドロップ＝そのタスクのサブタスクにする（親フォルダへ同居）/ drop onto a task = make it that task's subtask
          this.makeDropTarget(tr, (src) => void this.reparentTo(src, this.taskFolder(t.path), t.path));
        } else if (this.groupBy === "tag") {
          // タグ表示ではタググループへドラッグしてタグ付け（タスクへのドロップ＝サブタスク化はしない）
          // when grouping by tag, drag onto a tag group to tag (no subtask drop)
          this.makeDraggableTask(tr, t.path);
        }
      }
    }

    // (4) タイムライン SVG / timeline SVG
    const svgWrap = grid.createDiv({ cls: "ogantt-svgwrap" });
    const svg = svgWrap.createSvg("svg", { cls: "ogantt-svg" });
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(bodyH));
    this.drawGrid(svg, width, bodyH);
    // 依存作成ハンドルは専用レイヤーに集め、依存矢印より後に追加＝最前面で掴みやすい
    // collect connector handles in their own layer, appended after the arrows so they stay topmost and grabbable
    const handlesLayer = svgEl("g", { class: "ogantt-handles-layer" });
    this.drawBars(svg, handlesLayer);
    this.drawDependencies(svg); // バーの上に描いて矢印を隠さない / on top of bars so arrows stay visible
    svg.appendChild(handlesLayer); // 矢印の上にハンドルを重ねる / handles above arrows
    // タイムライン上の空白エリアのクリックで行選択＋ノートを開く（バーのクリックは個別に stopPropagation している）
    // click on empty timeline space = select + open note (bar clicks stopPropagation individually)
    svg.addEventListener("click", (ev) => {
      if (ev.detail > 1) return; // dblclick の後に来る click は無視 / skip the click that follows a dblclick
      const box = svg.getBoundingClientRect();
      const rowIdx = Math.floor((ev.clientY - box.top) / ROW_H);
      const row = this.rows[rowIdx];
      if (row?.kind === "task" && row.task) void this.openTaskInSidebar(row.task.path);
    });
    svg.addEventListener("dblclick", (ev) => {
      const box = svg.getBoundingClientRect();
      const rowIdx = Math.floor((ev.clientY - box.top) / ROW_H);
      const row = this.rows[rowIdx];
      if (row?.kind === "task" && row.task) this.openTaskNote(row.task.path);
    });
  }

  private xOf(dateStr: string): number {
    return (dayIndex(dateStr) - this.range.min) * this.ppd;
  }

  private drawGrid(svg: SVGElement, width: number, height: number): void {
    // 選択行のタイムライン側ハイライト（バーや線より前に追加＝最背面）/ selected-row highlight on the timeline side (added first = behind everything)
    this.rows.forEach((row, i) => {
      if (row.kind === "task" && row.task?.path === this.selectedPath) {
        svg.appendChild(svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-row-sel" }));
      }
    });
    // 行の区切り / row separators
    this.rows.forEach((row, i) => {
      if (row.kind === "group") {
        const bg = svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-grid-group" });
        svg.appendChild(bg);
      }
      const line = svgEl("line", { x1: 0, y1: (i + 1) * ROW_H, x2: width, y2: (i + 1) * ROW_H, class: "ogantt-grid-row" });
      svg.appendChild(line);
    });
    // 今日の線 / today marker
    const todayX = (todayIndex() - this.range.min) * this.ppd;
    if (todayX >= 0 && todayX <= width) {
      svg.appendChild(svgEl("line", { x1: todayX, y1: 0, x2: todayX, y2: height, class: "ogantt-today" }));
    }
  }

  private drawBars(svg: SVGElement, handlesLayer: SVGElement): void {
    const statusColor = new Map(this.plugin.settings.statuses.map((s) => [s.id, s.color]));
    this.rows.forEach((row, i) => {
      // グループ行のまとめバー / group summary bar
      if (row.kind === "group") {
        if (!row.span) return;
        const gx = this.xOf(row.span.start);
        const gw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
        const gy = i * ROW_H + ROW_H / 2 - 3;
        svg.appendChild(svgEl("rect", { x: gx, y: gy, width: gw, height: 6, rx: 2, class: "ogantt-group-bar" }));
        // 端のキャップ / end caps
        svg.appendChild(svgEl("path", { d: `M ${gx} ${gy} l 0 8 l 5 -8 z`, class: "ogantt-group-cap" }));
        svg.appendChild(svgEl("path", { d: `M ${gx + gw} ${gy} l 0 8 l -5 -8 z`, class: "ogantt-group-cap" }));
        return;
      }
      const t = row.task!;
      // ロールアップ ON：子を持つ親は「子孫を含む範囲」のフルバーで描く（自分のバーは描かない）
      // rollup on: draw a parent as a full bar spanning its whole subtree (not its own bar)
      if (this.rollup && row.span) {
        const sx = this.xOf(row.span.start);
        const sw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
        const yy = i * ROW_H + BAR_PAD;
        const hh = ROW_H - BAR_PAD * 2;
        const c =
          this.colorBy === "assignee"
            ? t.assignee ? hashColor(t.assignee) : FALLBACK_BAR
            : (t.status && statusColor.get(t.status)) || FALLBACK_BAR;
        const rg = svgEl("g", { class: "ogantt-bar-g ogantt-rollup-g", "data-path": t.path }) as SVGGElement;
        rg.appendChild(svgEl("rect", { x: sx, y: yy, width: sw, height: hh, rx: 4, class: "ogantt-bar ogantt-rollup-bar", fill: c }));
        const sdays = dayIndex(row.span.end) - dayIndex(row.span.start) + 1;
        drawBarLabel(this.measurer, rg, sx, sw, i * ROW_H + ROW_H / 2, sdays, t.name);
        rg.addEventListener("click", (ev) => { ev.stopPropagation(); this.activateTask(t.path, ev); });
        rg.addEventListener("dblclick", (ev) => { ev.stopPropagation(); this.openTaskNote(t.path); });
        svg.appendChild(rg);
        return;
      }
      const aStart = anchorStart(t);
      if (!aStart) return;
      const y = i * ROW_H + BAR_PAD;
      const h = ROW_H - BAR_PAD * 2;
      const x = this.xOf(aStart);
      const color =
        this.colorBy === "assignee"
          ? t.assignee ? hashColor(t.assignee) : FALLBACK_BAR
          : (t.status && statusColor.get(t.status)) || FALLBACK_BAR;

      const g = svgEl("g", { class: "ogantt-bar-g", "data-path": t.path }) as SVGGElement;
      const cyMid = i * ROW_H + ROW_H / 2;
      let lx = x; // 左端ハンドル位置 / left handle x
      let rx = x; // 右端ハンドル位置 / right handle x

      if (t.milestone) {
        const cx = x;
        const cy = cyMid;
        const r = h / 2;
        const dia = svgEl("path", {
          d: `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`,
          class: "ogantt-milestone",
          fill: color,
        });
        g.appendChild(dia);
        this.attachDrag(g, dia, t);
        lx = cx - r;
        rx = cx + r;
      } else {
        const endStr = anchorEnd(t) ?? aStart;
        const w = Math.max((dayIndex(endStr) - dayIndex(aStart) + 1) * this.ppd, 6);
        const rect = svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar", fill: color });
        g.appendChild(rect);
        if (t.progress != null && t.progress > 0) {
          const pw = (w * Math.min(100, t.progress)) / 100;
          g.appendChild(svgEl("rect", { x, y, width: pw, height: h, rx: 4, class: "ogantt-bar-progress" }));
        }
        // バー内ラベル：左から「期間 名前」。名前はバー幅に収まる分だけ … で省略 / in-bar label "<days>d  <name>", name truncated with … to fit
        const days = dayIndex(endStr) - dayIndex(aStart) + 1;
        drawBarLabel(this.measurer, g, x, w, cyText(i), days, t.name);
        this.attachDrag(g, rect, t);
        // 端ホバーで ↔ カーソル、中央は掴むカーソル / ew-resize near edges, grab in the middle
        rect.addEventListener("mousemove", (e: MouseEvent) => {
          const box = rect.getBoundingClientRect();
          const off = e.clientX - box.left;
          rect.style.cursor = off < RESIZE_EDGE || off > box.width - RESIZE_EDGE ? "ew-resize" : "grab";
        });
        rx = x + w;
      }

      // 依存作成用の丸ハンドル（バーから少し離して配置。左=start, 右=finish）/ connector handles, detached from the bar
      // 別レイヤー（最前面）に置くので、表示はバー/ハンドルのホバーで JS 切替（CSS の子孫セレクタが効かないため）
      // they live in the topmost layer, so reveal them via JS hover on the bar or the handle (CSS descendant selector won't reach)
      const HGAP = 11; // バー端からの距離 / gap from the bar edge
      const handleDefs: [number, "start" | "finish"][] = [[lx - HGAP, "start"], [rx + HGAP, "finish"]];
      const handles: SVGElement[] = [];
      for (const [hx, end] of handleDefs) {
        const handle = svgEl("circle", { cx: hx, cy: cyMid, r: 5, class: "ogantt-handle" });
        handle.addEventListener("pointerdown", (e: PointerEvent) => this.startLink(g, svg, t, end, e));
        handle.addEventListener("mouseenter", () => handle.classList.add("is-visible"));
        handle.addEventListener("mouseleave", () => handle.classList.remove("is-visible"));
        handlesLayer.appendChild(handle);
        handles.push(handle);
      }
      g.addEventListener("mouseenter", () => handles.forEach((h) => h.classList.add("is-visible")));
      g.addEventListener("mouseleave", () => handles.forEach((h) => h.classList.remove("is-visible")));

      // シングルクリック＝横の詳細パネル（即開く）、ダブルクリック＝ノートを新規タブで開く。ドラッグ直後は抑止。
      // single click = side detail panel (opens instantly); double click = note in a new tab; suppressed right after a drag.
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.dragged.get(g)) return; // ドラッグだった＝開かない / it was a drag, not a click
        this.activateTask(t.path, ev);
      });
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.openTaskNote(t.path);
      });
      svg.appendChild(g);
    });

    function cyText(i: number): number {
      // dominant-baseline:middle が y を中心に合わせるので行の中心ちょうどを返す（旧 +4 はバー中心より下にずれていた）
      // the label CSS centers text on its y (dominant-baseline:middle), so return the exact row center; the old +4 sat below the bar's center
      return i * ROW_H + ROW_H / 2;
    }
  }

  // ハンドルから線を引いて他タスクへドロップ＝依存作成 / drag from a handle to another task = create dependency
  private startLink(g: SVGGElement, svg: SVGElement, source: Task, sourceEnd: "start" | "finish", ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragged.set(g, true); // バーのクリックを抑止 / suppress the bar click
    const handle = ev.target as Element;
    handle.setPointerCapture(ev.pointerId);
    const box = svg.getBoundingClientRect();
    const x1 = ev.clientX - box.left;
    const y1 = ev.clientY - box.top;
    const tmp = svgEl("path", { d: `M ${x1} ${y1} L ${x1} ${y1}`, class: "ogantt-link-temp" });
    svg.appendChild(tmp);

    const clearHi = () =>
      svg.querySelectorAll(".is-link-target").forEach((el) => el.removeClass("is-link-target"));
    const onMove = (e: PointerEvent) => {
      const x2 = e.clientX - box.left;
      const y2 = e.clientY - box.top;
      tmp.setAttribute("d", `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`);
      clearHi();
      const row = this.rows[Math.floor(y2 / ROW_H)];
      if (row?.kind === "task" && row.task && row.task.path !== source.path) {
        svg
          .querySelector(`.ogantt-bar-g[data-path="${CSS.escape(row.task.path)}"] .ogantt-bar, .ogantt-bar-g[data-path="${CSS.escape(row.task.path)}"] .ogantt-milestone`)
          ?.addClass("is-link-target");
      }
    };
    const onUp = (e: PointerEvent) => void (async () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      tmp.remove();
      clearHi();
      // クリック抑止フラグはこの後の click 後に解除 / clear the click-suppress flag after the click fires
      window.setTimeout(() => this.dragged.set(g, false), 0);
      const row = this.rows[Math.floor((e.clientY - box.top) / ROW_H)];
      if (row?.kind === "task" && row.task && row.task.path !== source.path) {
        const target = row.task;
        // ドロップ先のどの端か判定（左半分=start, 右半分=finish）/ which end was dropped on
        const tLeft = this.xOf(anchorStart(target) ?? anchorEnd(target)!);
        const tRight = this.xOf(anchorEnd(target) ?? anchorStart(target)!) + this.ppd;
        const targetEnd: "start" | "finish" = e.clientX - box.left < (tLeft + tRight) / 2 ? "start" : "finish";
        // 端の組み合わせで種類を決定 / pick the type from the connected ends
        // 先行=ドラッグ元(source/sourceEnd), 後続=ドロップ先(target/targetEnd)
        let type: DepType | null = null;
        if (sourceEnd === "finish" && targetEnd === "start") type = "FS";
        else if (sourceEnd === "finish" && targetEnd === "finish") type = "FF";
        else if (sourceEnd === "start" && targetEnd === "start") type = "SS";
        else type = null; // start→finish = SF は未対応 / SF unsupported
        if (type == null) {
          new Notice(tr().sfUnsupported);
        } else {
          await this.pushUndo(tr().undoAddDep(type));
          await addDependency(this.app, this.plugin.settings, target.path, source.path, type);
          // メモリにも依存を反映（metadataCache 更新前でも整列できるように）/ reflect dep in-memory
          target.deps = target.deps.filter((dd) => dd.path !== source.path);
          target.deps.push({ path: source.path, type });
          // SS/FF は後続の日付を先行に揃える（連鎖も）/ snap SS/FF successors to the predecessor
          await this.realignSuccessors(source.path);
          this.rerender();
        }
      }
    })();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  // SS/FF 依存に従って後続の日付を先行に揃える（期間は維持＝バーが移動）
  // align a successor to its predecessor per SS/FF (duration kept → the bar moves)
  private async applyAlign(target: Task, pred: Task, type: DepType): Promise<boolean> {
    // マイルストーンは固定日なので依存で動かさない / milestones are fixed dates: never auto-moved
    if (target.milestone) return false;
    const ps = anchorStart(pred);
    const pe = anchorEnd(pred);
    let ns: string | undefined;
    let ne: string | undefined;
    if (type === "FS") {
      // 先行の終了の翌日に後続の開始を合わせる / successor starts the day after predecessor's end
      if (!pe) return false;
      const startDay = dayIndex(pe) + 1;
      if (target.milestone) ns = ne = dayToStr(startDay);
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ns = dayToStr(startDay);
        ne = dayToStr(startDay + dur);
      }
    } else if (type === "SS") {
      if (!ps) return false;
      if (target.milestone) ns = ne = ps;
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ns = ps;
        ne = dayToStr(dayIndex(ps) + dur);
      }
    } else if (type === "FF") {
      if (!pe) return false;
      if (target.milestone) ns = ne = pe;
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ne = pe;
        ns = dayToStr(dayIndex(pe) - dur);
      }
    } else {
      return false;
    }

    // 変化が無ければ何もしない / skip if unchanged
    if (target.milestone) {
      if (target.end === ne) return false;
    } else if (target.start === ns && target.end === ne) {
      return false;
    }
    await writeDates(this.app, this.plugin.settings, target.path, ns, ne, target.milestone);
    // メモリ上も更新して連鎖整列に備える / update in-memory for cascading
    if (target.milestone) target.end = ne;
    else {
      target.start = ns;
      target.end = ne;
    }
    return true;
  }

  // 指定タスクの SS/FF 後続を整列し、連鎖的に伝播（循環は seen で打ち切り）
  // realign SS/FF successors of a task, propagating along chains (cycles stopped via `seen`)
  private async realignSuccessors(rootPath: string): Promise<boolean> {
    const queue = [rootPath];
    const seen = new Set<string>();
    let any = false;
    let guard = 0;
    while (queue.length && guard++ < 1000) {
      const predPath = queue.shift()!;
      const pred = this.tasks.find((t) => t.path === predPath);
      if (!pred) continue;
      for (const succ of this.tasks) {
        if (succ.path === predPath) continue;
        const dep = succ.deps.find((dd) => dd.path === predPath);
        if (!dep) continue;
        if (await this.applyAlign(succ, pred, dep.type)) {
          any = true;
          if (!seen.has(succ.path)) {
            seen.add(succ.path);
            queue.push(succ.path);
          }
        }
      }
    }
    return any;
  }

  private drawDependencies(svg: SVGElement): void {
    const rowOf = new Map<string, number>();
    this.rows.forEach((r, i) => {
      if (r.kind === "task") rowOf.set(r.task!.path, i);
    });
    const GAP = 12;
    for (const t of this.tasks) {
      const si = rowOf.get(t.path);
      if (si == null) continue;
      const sStart = anchorStart(t);
      const sEnd = anchorEnd(t);
      if (!sStart || !sEnd) continue;
      const sLeft = this.xOf(sStart);
      const sRight = this.xOf(sEnd) + this.ppd;
      const sy = si * ROW_H + ROW_H / 2;

      for (const dep of t.deps) {
        const pi = rowOf.get(dep.path);
        const pred = this.tasks.find((x) => x.path === dep.path);
        if (pi == null || !pred) continue;
        const pStartD = anchorStart(pred);
        const pEndD = anchorEnd(pred);
        if (!pStartD || !pEndD) continue;
        const pLeft = this.xOf(pStartD);
        const pRight = this.xOf(pEndD) + this.ppd;
        const py = pi * ROW_H + ROW_H / 2;
        const mid = (py + sy) / 2;

        let d: string;
        let mxX: number;
        const mxY = mid;
        let arrowD: string;
        let violation = false;

        if (dep.type === "FS") {
          // 先行の終了 → 後続の開始（左から差し込む）/ pred finish → succ start
          const sx0 = pRight;
          const tx = sLeft;
          // FS は翌日以降が正常。先行end と同日以前は違反 / successor must start the day after; same day or earlier is a violation
          violation = dayIndex(sStart) <= dayIndex(pEndD);
          if (tx - sx0 > GAP * 2) {
            const mx = sx0 + Math.max(GAP, (tx - sx0) / 2);
            d = elbowPath([[sx0, py], [mx, py], [mx, sy], [tx, sy]]);
            mxX = mx;
          } else {
            const ax = sx0 + GAP;
            const bx = tx - GAP;
            d = elbowPath([[sx0, py], [ax, py], [ax, mid], [bx, mid], [bx, sy], [tx, sy]]);
            mxX = (ax + bx) / 2;
          }
          arrowD = `M ${tx} ${sy} l -7 -4 l 0 8 z`; // 右向き / points right
        } else if (dep.type === "SS") {
          // 先行の開始 → 後続の開始（左側を回る）/ pred start → succ start
          const sx0 = pLeft;
          const tx = sLeft;
          violation = dayIndex(sStart) < dayIndex(pStartD);
          const leftMost = Math.min(sx0, tx) - GAP;
          d = elbowPath([[sx0, py], [leftMost, py], [leftMost, sy], [tx, sy]]);
          mxX = leftMost;
          arrowD = `M ${tx} ${sy} l -7 -4 l 0 8 z`; // 右向き / points right
        } else {
          // FF: 先行の終了 → 後続の終了（右側を回る）/ pred finish → succ finish
          const sx0 = pRight;
          const tx = sRight;
          violation = dayIndex(sEnd) < dayIndex(pEndD);
          const rightMost = Math.max(sx0, tx) + GAP;
          d = elbowPath([[sx0, py], [rightMost, py], [rightMost, sy], [tx, sy]]);
          mxX = rightMost;
          arrowD = `M ${tx} ${sy} l 7 -4 l 0 8 z`; // 左向き / points left
        }

        const succPath = t.path;
        const predPath = dep.path;
        const depType = dep.type;
        const depG = svgEl("g", { class: "ogantt-dep-g" }) as SVGGElement;

        const hit = svgEl("path", { d, class: "ogantt-dep-hit" });
        const tip = svgEl("title", {});
        tip.textContent = tr().depTooltip(depType);
        hit.appendChild(tip);
        depG.appendChild(hit);
        depG.appendChild(svgEl("path", { d, class: "ogantt-dep" + (violation ? " is-violation" : "") }));
        depG.appendChild(svgEl("path", {
          d: arrowD,
          class: "ogantt-dep-arrow" + (violation ? " is-violation" : ""),
        }));

        // FS 以外は種類ラベルを表示 / show a type label for non-FS
        if (depType !== "FS") {
          const lbl = svgEl("text", { x: mxX, y: mxY - 9, class: "ogantt-dep-type" });
          lbl.textContent = depType;
          depG.appendChild(lbl);
        }

        // ホバーで出る × 目印 / X marker shown on hover
        const xg = svgEl("g", { class: "ogantt-dep-x" }) as SVGGElement;
        xg.appendChild(svgEl("circle", { cx: mxX, cy: mxY, r: 8, class: "ogantt-dep-x-bg" }));
        xg.appendChild(svgEl("path", {
          d: `M ${mxX - 3} ${mxY - 3} L ${mxX + 3} ${mxY + 3} M ${mxX + 3} ${mxY - 3} L ${mxX - 3} ${mxY + 3}`,
          class: "ogantt-dep-x-mark",
        }));
        depG.appendChild(xg);

        // クリック → 確認なしで即切断（Ctrl+Z で取り消し可）/ click → remove immediately (undo with Ctrl+Z)
        depG.addEventListener("click", (ev: MouseEvent) => void (async () => {
          ev.stopPropagation();
          await this.pushUndo(tr().undoRemoveDep(depType));
          await removeDependency(this.app, this.plugin.settings, succPath, predPath);
          await this.refresh();
        })());
        svg.appendChild(depG);
      }
    }
  }

  // ドラッグ中にバー内ラベル（期間＋名前）を丸ごと再描画。静的描画と同じ drawBarLabel を使うのでズレない
  // redraw the whole in-bar label (duration + name) while dragging; reuses drawBarLabel so it matches the static render exactly
  private liveBarLabel(g: SVGGElement, rect: SVGElement, x: number, w: number, days: number, name: string): void {
    g.querySelectorAll(".ogantt-bar-intext").forEach((el) => el.remove());
    const cy = parseFloat(rect.getAttribute("y")!) + parseFloat(rect.getAttribute("height")!) / 2;
    drawBarLabel(this.measurer, g, x, w, cy, days, name);
  }

  // バー/菱形のドラッグで日付を書き戻す / drag a bar or diamond to reschedule
  private attachDrag(g: SVGGElement, handle: SVGElement, task: Task): void {
    const EDGE = RESIZE_EDGE;
    const milestone = task.milestone;
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      // preventDefault はフォーカスを移さないため、入力中の欄を明示的に外す（Ctrl+Z をガント側へ）
      // preventDefault keeps focus on a previously focused input; blur it so Ctrl+Z reaches the gantt undo
      (activeDocument.activeElement as HTMLElement | null)?.blur?.();
      this.dragged.set(g, false);
      const startX = ev.clientX;
      handle.setPointerCapture(ev.pointerId);

      let mode: "move" | "l" | "r" = "move";
      let x0 = 0;
      let w0 = 0;
      if (!milestone) {
        x0 = parseFloat(handle.getAttribute("x")!);
        w0 = parseFloat(handle.getAttribute("width")!);
        // rect 実画面座標から相対オフセットを求める（SVG の offsetX は不正確）
        // use screen box for offset; SVG offsetX is unreliable in Chromium
        const box = handle.getBoundingClientRect();
        const offset = ev.clientX - box.left;
        mode = offset < EDGE ? "l" : offset > box.width - EDGE ? "r" : "move";
      }

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 3) this.dragged.set(g, true);
        if (milestone) {
          g.setAttribute("transform", `translate(${dx},0)`);
          return;
        }
        if (mode === "move") handle.setAttribute("x", String(x0 + dx));
        else if (mode === "r") handle.setAttribute("width", String(Math.max(this.ppd, w0 + dx)));
        else {
          handle.setAttribute("x", String(x0 + dx));
          handle.setAttribute("width", String(Math.max(this.ppd, w0 - dx)));
        }
        // バー内ラベル（期間＋名前）と全体進捗をライブ更新 / live-update the in-bar label (duration + name) and overall progress
        const nx = parseFloat(handle.getAttribute("x")!);
        const nw = parseFloat(handle.getAttribute("width")!);
        const days = Math.max(1, Math.round(nw / this.ppd));
        this.liveBarLabel(g, handle, nx, nw, days, task.name);
        this.updateProjectProgress({ path: task.path, days });
      };
      const onUp = (e: PointerEvent) => void (async () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        const dxDays = Math.round((e.clientX - startX) / this.ppd);
        if (dxDays !== 0) {
          await this.pushUndo(tr().undoReschedule(task.name));
          if (milestone) {
            const nd = dayToStr(dayIndex(task.end ?? task.start!) + dxDays);
            await writeDates(this.app, this.plugin.settings, task.path, nd, nd, true);
            task.end = nd; // メモリ更新 / update in-memory
          } else {
            const s0 = dayIndex(task.start!);
            const e0 = dayIndex(task.end ?? task.start!);
            let ns = s0;
            let ne = e0;
            if (mode === "move") {
              ns = s0 + dxDays;
              ne = e0 + dxDays;
            } else if (mode === "r") {
              ne = Math.max(s0, e0 + dxDays);
            } else {
              ns = Math.min(e0, s0 + dxDays);
            }
            const nsS = dayToStr(ns);
            const neS = dayToStr(ne);
            await writeDates(this.app, this.plugin.settings, task.path, nsS, neS, false);
            task.start = nsS; // メモリ更新 / update in-memory
            task.end = neS;
          }
          // SS/FF 後続を連動（メモリ更新＋ディスク書き込み）/ cascade to SS/FF successors
          await this.realignSuccessors(task.path);
          // メモリから即再描画（ディスク再読込前に正しい位置を表示）/ render from memory for instant correct positions
          this.rerender();
        } else {
          // 日数変化なし＝クリック扱い。動かした分を視覚的に元へ戻すだけ（再描画しない）。
          // これで要素が残り click/dblclick が発火し、詳細パネルを開ける。
          // No day change = a click: reset any sub-threshold movement without re-rendering,
          // so the element survives and click/dblclick fire to open the detail panel.
          if (milestone) {
            g.removeAttribute("transform");
          } else {
            handle.setAttribute("x", String(x0));
            handle.setAttribute("width", String(w0));
            // ライブ更新したバー内ラベルと全体進捗を元へ戻す / revert the live-updated in-bar label and overall progress too
            this.liveBarLabel(g, handle, x0, w0, Math.max(1, Math.round(w0 / this.ppd)), task.name);
            this.updateProjectProgress();
          }
        }
      })();
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ----- 新規タスク作成 / create a new task -----
  // 今のフォルダに 1 日タスク（開始=終了=今日）を作り、サイドバーのネイティブ表示で開く（命名はノートのリネームで）
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

  private async createTaskInFolder(folderPath: string): Promise<void> {
    const file = await createTask(this.app, folderPath, tr().newTaskName);
    if (!file) return;
    const k = this.plugin.settings.keys;
    const today = dayToStr(todayIndex());
    await writeField(this.app, file.path, k.start, today);
    await writeField(this.app, file.path, k.end, today);
    await this.refresh();
    this.startInlineEdit(file.path);
  }

  private async createNewTask(): Promise<void> {
    const file = await createTask(this.app, this.folder, tr().newTaskName);
    if (!file) return;
    const k = this.plugin.settings.keys;
    const today = dayToStr(todayIndex());
    await writeField(this.app, file.path, k.start, today);
    await writeField(this.app, file.path, k.end, today);
    await this.refresh();
    this.startInlineEdit(file.path);
  }

  private async createSubtask(parentPath: string): Promise<void> {
    const parentFolder = this.taskFolder(parentPath);
    const file = await createTask(this.app, parentFolder, tr().newTaskName);
    if (!file) return;
    const k = this.plugin.settings.keys;
    const today = dayToStr(todayIndex());
    await writeField(this.app, file.path, k.start, today);
    await writeField(this.app, file.path, k.end, today);
    const parentFile = this.app.vault.getAbstractFileByPath(parentPath);
    if (parentFile instanceof TFile) {
      await writeField(this.app, file.path, k.parent, this.app.fileManager.generateMarkdownLink(parentFile, file.path));
    }
    await this.refresh();
    this.startInlineEdit(file.path);
  }

  // ----- ドラッグ＆ドロップ（フォルダへ＝親解除して移動／タスクへ＝サブタスク化）-----
  // ----- drag & drop (onto a folder = detach + move; onto a task = make subtask) -----
  // タスク行をドラッグ可能にする / make a task row draggable
  private makeDraggableTask(row: HTMLElement, path: string): void {
    row.setAttr("draggable", "true");
    row.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
  }

  // 行をドロップ先にする（ドロップ時に handler(srcPath) を呼ぶ）/ make a row a drop target
  private makeDropTarget(row: HTMLElement, handler: (srcPath: string) => void): void {
    row.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault(); // preventDefault でドロップを許可 / allow dropping
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

  // タスクパスの所属フォルダ（無ければ Vault ルート＝""）/ a task's folder dir ("" = vault root)
  private taskFolder(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  // 親の設定/解除＋サブツリー移動を実行して再描画（取り消し可）/ set/clear parent, move subtree, re-render (undoable)
  // parentTaskPath != null → サブタスク化（その親フォルダへ）／null → 解除（destFolder のトップレベルへ）
  private async reparentTo(srcPath: string, destFolder: string, parentTaskPath: string | null): Promise<void> {
    if (srcPath === parentTaskPath) return; // 自分自身へは不可 / not onto itself
    // 循環防止：親が src の子孫であってはならない / cycle guard: parent must not be a descendant of src
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

  // タググループへのドロップでタグを付与（取り消し可・既に付いていれば何もしない）/ add a tag via drop (undoable; no-op if already tagged)
  private async addTagTo(srcPath: string, tag: string): Promise<void> {
    const pre = this.tasks.find((x) => x.path === srcPath);
    if (!pre || pre.tags.includes(tag)) return;
    await this.pushUndo(tr().undoAddTag(pre.name, tag));
    await addTag(this.app, srcPath, tag);
    // 背景 refresh で this.tasks が作り替わる場合に備え、最新を引き直して更新 / look up the live task (survives a background refresh)
    const live = this.tasks.find((x) => x.path === srcPath);
    if (live && !live.tags.includes(tag)) live.tags.push(tag);
    this.rerender();
  }

  // シングルクリック＝そのタスクのノートを右サイドバーで開く（ネイティブ表示）。
  // ダブルクリックの2回目以降（ev.detail > 1）は無視。ノートのフル編集は dblclick 側でメインタブに開く。
  // single click = open the task's note in the right sidebar (native view).
  // ignore the 2nd+ click of a double (ev.detail > 1); full editing opens in a main tab via the dblclick handler.
  private activateTask(path: string, ev: MouseEvent): void {
    if (ev.detail > 1) return;
    void this.openTaskInSidebar(path);
  }

  // タスクのノートを右サイドバーの 1 枚のリーフで開く（毎回使い回す＝ネイティブのファイルナビゲーション風）
  // open the task's note in a single, reused right-sidebar leaf — like native file navigation, no tab pile-up
  private async openTaskInSidebar(path: string): Promise<void> {
    // повторный клик по уже выбранному таску закрывает сайдбар / second click on the same task closes the sidebar
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
    await leaf.openFile(file, { active: false }); // フォーカスは Gantt に残す / keep focus on the Gantt
    void this.app.workspace.revealLeaf(leaf); // サイドバーが畳まれていたら開く / uncollapse the sidebar if it's collapsed
    this.markSelected(path);
  }

  // そのリーフがまだワークスペースに存在するか / whether the leaf is still attached to the workspace
  private isLeafAttached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) found = true; });
    return found;
  }

  // 選択行のハイライトを更新（サイドバーに表示中のタスクを示す）/ update the selected-row highlight (marks the task shown in the sidebar)
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

  // ダブルクリック＝ノートを新規タブで開く / double click = open the note in a new tab
  private openTaskNote(path: string): void {
    void this.app.workspace.openLinkText(path, "", "tab");
  }

  // 確認ダイアログを挟んでタスクを削除（ゴミ箱へ）/ confirm, then delete the task (to trash)
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
        // 削除したタスクが選択中なら選択を解除 / clear the selection if the deleted task was selected
        if (this.selectedPath === path) this.selectedPath = null;
        new Notice(tr().deletedNotice(t.name));
        await this.refresh();
      })(),
    }).open();
  }

  // フィールド保存（空なら削除）/ save a frontmatter field (delete if empty)
  private async saveField(key: string, value: string): Promise<void> {
    if (!this.selectedPath) return;
    await writeField(this.app, this.selectedPath, key, value === "" ? undefined : value);
    await this.refresh();
  }

  // 日付エリア：開始・終了を横並びチップで表示、各×でクリア、クリックで範囲カレンダーを開く
  // dates area: start & end chips side by side, each clearable with ×, click opens the range calendar
  private buildDates(meta: HTMLElement, t: Task): void {
    const fmt = this.plugin.settings.dateFormat;
    const k = this.plugin.settings.keys;
    const state = { start: t.start ?? "", end: t.end ?? "" };
    // 時刻（任意）。日付があるときだけ編集できる / optional time of day, editable only when the date is set
    const times = { start: t.startTime ?? "", end: t.endTime ?? "" };

    const row = meta.createDiv({ cls: "ogantt-detail-row" });
    row.createSpan({ cls: "ogantt-detail-label", text: tr().fieldDates });
    const chips = row.createDiv({ cls: "ogantt-detail-field ogantt-date-chips" });

    const painters: (() => void)[] = [];
    const repaint = () => painters.forEach((p) => p());

    // 開始・終了を両方フロントマターへ（空は削除・時刻があれば日付に併記）
    // persist both ends (delete when empty; append the time of day when set)
    const save = async (): Promise<void> => {
      if (!this.selectedPath) return;
      // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
      if (state.start && !state.end) state.end = state.start;
      // 同日で 開始時刻 > 終了時刻 は無効 → 終了=開始に補正 / clamp so start ≤ end within the same day
      if (state.start && state.start === state.end && times.start && times.end && times.end < times.start) {
        times.end = times.start;
      }
      repaint(); // 補正を即時反映 / reflect any clamping right away
      await this.pushUndo(tr().undoReschedule(t.name)); // Ctrl+Z で取り消し可 / undoable
      const tz = this.plugin.settings.tz;
      await writeField(this.app, this.selectedPath, k.start, combineDateTime(state.start || undefined, times.start, tz));
      await writeField(this.app, this.selectedPath, k.end, combineDateTime(state.end || undefined, times.end, tz));
      await this.refresh();
    };

    const makeChip = (which: "start" | "end"): void => {
      const chip = chips.createDiv({ cls: "ogantt-date-chip" });
      const ico = chip.createSpan({ cls: "ogantt-date-ico" });
      setIcon(ico, "calendar");
      const val = chip.createSpan({ cls: "ogantt-date-val" });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().clearDate);
      const paint = () => {
        const iso = state[which];
        // ×の表示/非表示は .is-empty に応じて CSS 側で制御 / × visibility is handled by CSS via .is-empty
        if (iso) {
          // 時刻があれば日付の後ろに表示 / show the time of day after the date when set
          val.setText(formatDate(iso, fmt) + (times[which] ? ` ${times[which]}` : ""));
          chip.removeClass("is-empty");
        } else {
          val.setText(which === "start" ? tr().fieldStart : tr().fieldDue);
          chip.addClass("is-empty");
        }
      };
      painters.push(paint);
      chip.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".ogantt-date-x")) return; // ×は別処理 / handled below
        this.openRangePicker(chip, state, which, repaint, save);
      });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        state[which] = "";
        repaint();
        void save();
      });
    };

    makeChip("start");
    makeChip("end");

    // 時刻入力（開始・終了）：手動入力は1分単位、時計アイコンは時・分（10分刻み）ドロップダウン
    // ネイティブピッカーは step を無視して1分刻みになる（Chromium）ため、アイコン側は自前ポップアップ
    // time-of-day for start & end: manual typing at 1-minute precision, the clock icon opens
    // hour + minute (10-min steps) dropdowns (Chromium's native picker ignores `step`)
    const trow = meta.createDiv({ cls: "ogantt-detail-row" });
    trow.createSpan({ cls: "ogantt-detail-label", text: tr().fieldTime });
    const tfield = trow.createDiv({ cls: "ogantt-detail-field ogantt-time-inputs" });
    const makeTime = (which: "start" | "end"): void => {
      const wrap = tfield.createDiv({ cls: "ogantt-time-wrap" });
      const inp = wrap.createEl("input", { cls: "ogantt-time-input", type: "time" });
      const btn = wrap.createEl("button", { cls: "clickable-icon ogantt-time-btn" });
      setIcon(btn, "clock");
      btn.setAttr("aria-label", tr().fieldTime);
      const paint = () => {
        inp.value = times[which];
        const dis = !state[which] || (which === "start" && t.milestone);
        inp.disabled = dis;
        btn.disabled = dis;
      };
      painters.push(paint);
      const apply = (v: string) => {
        times[which] = v;
        // 同日で開始>終了になったら常に「終了=開始」へ補正（開始は変更しない）
        // if start > end on the same day, always clamp end = start (never move the start)
        if (state.start && state.start === state.end && times.start && times.end && times.end < times.start) {
          times.end = times.start;
        }
        repaint(); // チップの時刻表示を更新 / refresh the time shown on the chips
        void save();
      };
      inp.addEventListener("change", () => apply(inp.value)); // 手動入力は1分単位OK / manual entry: any minute
      btn.addEventListener("click", () => this.openTimeDropdown(btn, times[which], apply));
    };
    makeTime("start");
    makeTime("end");
    repaint();
  }

  // 時計アイコンのポップアップ：時・分（10分刻み）のドロップダウンで時刻を選ぶ。×で時刻クリア
  // clock-icon popup: pick a time with hour + minute (10-min steps) dropdowns; × clears the time
  private openTimeDropdown(anchor: HTMLElement, current: string, apply: (v: string) => void): void {
    activeDocument.querySelectorAll(".ogantt-timepick").forEach((e) => e.remove());
    const pad = (n: number): string => String(n).padStart(2, "0");
    const pop = activeDocument.body.createDiv({ cls: "ogantt-timepick" });
    const close = () => {
      pop.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!pop.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);

    const [ch, cm] = /^\d{2}:\d{2}$/.test(current) ? current.split(":") : ["09", "00"];
    const hourSel = pop.createEl("select", { cls: "dropdown" });
    for (let h = 0; h < 24; h++) hourSel.createEl("option", { value: pad(h), text: pad(h) });
    hourSel.value = ch;
    pop.createSpan({ text: ":" });
    const minSel = pop.createEl("select", { cls: "dropdown" });
    for (let m = 0; m < 60; m += 10) minSel.createEl("option", { value: pad(m), text: pad(m) });
    // 10分刻みに乗らない既存値（手動入力等）も選べるように / keep an off-grid minute (manual entry) selectable
    if (!minSel.querySelector(`option[value="${cm}"]`)) minSel.createEl("option", { value: cm, text: cm });
    minSel.value = cm;
    const onPick = () => apply(`${hourSel.value}:${minSel.value}`);
    hourSel.addEventListener("change", onPick);
    minSel.addEventListener("change", onPick);
    const clr = pop.createEl("button", { cls: "clickable-icon" });
    setIcon(clr, "x");
    clr.setAttr("aria-label", tr().clearDate);
    clr.onclick = () => { apply(""); close(); };

    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  }

  // 非 name 列のセル内容を描画 / fill a non-name cell by column id
  private renderCell(td: HTMLElement, row: Row, id: ColumnId): void {
    const t = row.task!;
    const fmt = this.plugin.settings.dateFormat;
    // ロールアップ ON の親は、開始/終了セルも集約値を表示（バーと一致・編集不可）
    // when rolled up, a parent's Start/Due cells show the aggregated span too (matches the bar; not editable)
    const rolled = this.rollup && row.span ? row.span : null;
    switch (id) {
      case "start":
        if (rolled) {
          td.setText(formatDate(rolled.start, fmt));
        } else if (t.milestone) {
          // マイルストーンは開始列に菱形マーカー（開始日を持たない＝編集不可）/ diamond marker; no start to edit
          td.setText("◆");
          td.addClass("ogantt-td-ms");
        } else {
          // 時刻があれば併記 / append the time of day when set
          td.setText(formatDate(t.start, fmt) + (t.startTime ? ` ${t.startTime}` : ""));
          this.makeDateCell(td, t, "start");
        }
        break;
      case "end":
        if (rolled) {
          td.setText(formatDate(rolled.end, fmt));
        } else {
          td.setText(formatDate(t.end, fmt) + (t.endTime ? ` ${t.endTime}` : ""));
          this.makeDateCell(td, t, "end");
        }
        break;
      case "assignee":
        td.setText(t.assignee ?? "");
        break;
      case "status": {
        td.addClass("ogantt-td-status"); // ドットとラベルを縦中央に揃える / vertically center the dot + label
        const s = this.plugin.settings.statuses.find((x) => x.id === t.status);
        if (s) {
          const dot = td.createSpan({ cls: "ogantt-status-dot" });
          dot.style.background = s.color;
          td.createSpan({ text: s.label });
        } else {
          // 未設定でもクリックできるよう薄いプレースホルダを出す / faint placeholder so empty cells stay clickable
          td.createSpan({ cls: "ogantt-status-empty", text: "—" });
        }
        this.makeStatusCell(td, t);
        break;
      }
      case "tags": {
        // タグをチップで表示（多値）/ tags as chips (multi-valued)
        td.addClass("ogantt-td-tags");
        for (const tag of t.tags) {
          const chip = td.createSpan({ cls: "ogantt-tag-chip", text: tag });
          paintTagChip(this.plugin.settings, chip, tag);
          // タグチップを右クリック＝色を変更 / right-click a tag chip to change its color
          chip.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openColorMenu(e, "tag", tag); });
        }
        break;
      }
      case "name":
        break; // name は呼び出し側で処理 / handled by the caller
    }
  }

  // テーブルの日付セルをダブルクリックで直接編集可能にする / make a table date cell editable via double-click
  private makeDateCell(cell: HTMLElement, t: Task, which: "start" | "end"): void {
    cell.addClass("ogantt-td-editable");
    cell.setAttr("aria-label", tr().pickDate);
    // セルのシングルクリックは詳細を開かない（日付編集に専念）/ a single click here edits dates, not opens detail
    cell.addEventListener("click", (e) => e.stopPropagation());
    cell.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.openCellDatePicker(cell, t, which);
    });
  }

  // テーブルのステータスセルをシングルクリックで直接編集 / make a table status cell editable via single click
  private makeStatusCell(cell: HTMLElement, t: Task): void {
    cell.addClass("ogantt-td-editable");
    cell.setAttr("aria-label", tr().fieldStatus);
    // セルのクリックは詳細を開かずステータス選択に専念 / a click here picks a status, not opens detail
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openStatusMenu(cell, t);
    });
  }

  // セル直下にステータス選択メニューを開いて即書き込み / pop a status picker under the cell and write through
  private openStatusMenu(anchor: HTMLElement, t: Task): void {
    const k = this.plugin.settings.keys;
    const choose = async (id: string | undefined): Promise<void> => {
      if ((t.status ?? "") === (id ?? "")) return; // 変更なし / no change
      await this.pushUndo(`${t.name} — ${tr().fieldStatus}`); // Ctrl+Z で取り消し可 / undoable
      await writeField(this.app, t.path, k.status, id);
      await this.refresh();
    };
    const m = new Menu();
    // 未設定（クリア）/ unset (clear)
    m.addItem((i) => i.setTitle("—").setChecked(t.status == null).onClick(() => void choose(undefined)));
    for (const s of this.plugin.settings.statuses) {
      m.addItem((i) => i.setTitle(s.label).setChecked(s.id === t.status).onClick(() => void choose(s.id)));
    }
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  // テーブルのセルから範囲カレンダーを開いて日付を直接編集 / open the range calendar from a table cell
  private openCellDatePicker(anchor: HTMLElement, t: Task, which: "start" | "end"): void {
    const k = this.plugin.settings.keys;
    const state = { start: t.start ?? "", end: t.end ?? "" };
    const save = async (): Promise<void> => {
      // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
      if (state.start && !state.end) state.end = state.start;
      // 既存の時刻は日付変更後も引き継ぐ（同日で逆転したら終了=開始に補正）
      // keep the existing time of day across the date change (clamp if inverted on the same day)
      const ts = t.startTime;
      let te = t.endTime;
      if (state.start && state.start === state.end && ts && te && te < ts) te = ts;
      await this.pushUndo(tr().undoReschedule(t.name)); // Ctrl+Z で取り消し可 / undoable
      const tz = this.plugin.settings.tz;
      await writeField(this.app, t.path, k.start, combineDateTime(state.start || undefined, ts, tz));
      await writeField(this.app, t.path, k.end, combineDateTime(state.end || undefined, te, tz));
      await this.refresh();
    };
    // repaint はテーブル側では不要（save→refresh で再描画される）/ no chip repaint needed here
    this.openRangePicker(anchor, state, which, () => {}, save);
  }

  // 範囲カレンダー（開始・終了を1つで指定。月移動は ←→・テーマ追従）
  // range calendar: pick start & end in one popup; month nav ← →, theme-aware
  private openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>
  ): void {
    activeDocument.querySelectorAll(".ogantt-cal").forEach((e) => e.remove());
    const todayStr = dayToStr(todayIndex());
    const base = state[active] || state.start || state.end || todayStr;
    let y = parseInt(base.slice(0, 4), 10);
    let m = parseInt(base.slice(5, 7), 10); // 1-based
    let act = active; // 次のクリックで設定する端点 / endpoint the next click sets
    const wk = moment.weekdaysMin(); // ロケールの曜日略称（日曜始まり）/ localized minimal weekday names (Sunday-first)

    const cal = activeDocument.body.createDiv({ cls: "ogantt-cal" });
    const close = () => {
      cal.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!cal.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };

    let mode: "day" | "year" = "day"; // 日ビュー / 年（12ヶ月）ビュー / day view or year (12-month) view
    const months = moment.monthsShort(); // ロケールの月名略称 / localized short month names

    // 端点を1つ設定して交互に切り替え。逆転時は常に「終了=開始」へ補正（開始は変更しない）
    // set one endpoint, then alternate; on inversion always clamp end = start (never move the start)
    const pick = (ds: string) => {
      if (act === "start") {
        state.start = ds;
        if (state.end && ds > state.end) state.end = ds; // 終了が前に残ったら追従 / end follows forward
        act = "end";
      } else {
        // 開始より前を選んだら終了=開始 / picking before the start clamps end to the start
        state.end = state.start && ds < state.start ? state.start : ds;
        act = "start";
      }
      repaint();
      void save();
      render();
    };

    // 日ビュー / day view
    const renderDay = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { if (--m < 1) { m = 12; y--; } render(); };
      // タイトルをクリックで年ビューへ / click the title to open the year view
      const title = head.createEl("button", { cls: "ogantt-cal-title", text: `${y} / ${String(m).padStart(2, "0")}` });
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
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
        m = parseInt(todayStr.slice(5, 7), 10); // 表示も今日の月へ / move the view to today
        pick(todayStr);
      };
      const clearBtn = foot.createEl("button", { text: tr().clearDate });
      clearBtn.onclick = () => { state[act] = ""; repaint(); void save(); render(); };
    };

    // 年ビュー（12ヶ月）/ year view (12 months)
    const renderYear = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { y--; render(); }; // ← → で年移動 / year nav
      head.createSpan({ cls: "ogantt-cal-title", text: `${y}` });
      const next = head.createEl("button", { cls: "clickable-icon" });
      setIcon(next, "chevron-right");
      next.onclick = () => { y++; render(); };

      const grid = cal.createDiv({ cls: "ogantt-cal-months" });
      for (let mm = 1; mm <= 12; mm++) {
        const cell = grid.createEl("button", { cls: "ogantt-cal-month", text: months[mm - 1] });
        if (mm === m) cell.addClass("is-current");
        const ym = `${y}-${String(mm).padStart(2, "0")}`;
        if (state.start.startsWith(ym) || state.end.startsWith(ym)) cell.addClass("is-selected"); // 端点を含む月 / months holding an endpoint
        cell.onclick = () => { m = mm; mode = "day"; render(); };
      }
    };

    const render = () => {
      cal.empty();
      if (mode === "year") renderYear();
      else renderDay();
    };
    render();

    // 位置：チップの下（画面外なら上へ反転）/ position below the chip (flip up if it would overflow)
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + cal.offsetHeight > window.innerHeight) top = Math.max(4, r.top - cal.offsetHeight - 4);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - cal.offsetWidth - 8));
    cal.style.top = `${top}px`;
    cal.style.left = `${left}px`;

    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);
  }

}
