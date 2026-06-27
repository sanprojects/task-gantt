import { setIcon, Menu, Notice } from "obsidian";
import { Task, ZoomMode, DepType } from "../types";
import { ROW_H, HEAD_H, BAR_PAD, RESIZE_EDGE, MAX_INDENT_DEPTH, FALLBACK_BAR } from "../viewConstants";
import { dayIndex, dayToStr, todayIndex, buildTicks } from "../timeline";
import { anchorStart, anchorEnd, addDependency, removeDependency, renameTask, writeDates } from "../model";
import { svgEl, drawBarLabel, elbowPath } from "../svg";
import { hashColor, folderColor, tagColor } from "../color";
import { t as tr } from "../i18n";
import { ViewCtx } from "./context";
import { realignSuccessors } from "./depAlign";

// Timeline + table grid rendering and its in-SVG interactions (bar drag, dependency links).
// All entry through renderGrid(ctx, main); everything else is internal to this module.
export function renderGrid(ctx: ViewCtx, main: HTMLElement): void {
  const totalDays = ctx.range.max - ctx.range.min + 1;
  const width = totalDays * ctx.ppd;
  const bodyH = ctx.rows.length * ROW_H;

  const cols = ctx.visibleColumns();
  const grid = main.createDiv({ cls: "ogantt-grid" });
  grid.style.gridTemplateColumns = `${ctx.tableWidth()}px ${width}px`;
  grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;

  // 行ループ内ではローカル変数 tr（行要素）が i18n の tr() を隠すため、先に文言を退避
  // the row var `tr` shadows the i18n tr() inside the loop, so grab strings up front
  const strings = tr();

  // (1) 左上の角＝表ヘッダー（表示中の列を並べる・クリックでソート）/ top-left corner = header (click to sort)
  const corner = grid.createDiv({ cls: "ogantt-corner" });
  for (const id of cols) {
    const th = corner.createDiv({ cls: "ogantt-th ogantt-th-sortable" + (id === "name" ? " ogantt-th-name" : "") });
    if (id !== "name") th.style.width = `${ctx.colW(id)}px`;
    th.createSpan({ text: ctx.colLabel(id) });
    // アクティブなソート列に ↑/↓ を表示 / show ↑/↓ on the active sort column
    if (ctx.plugin.settings.sortBy === id) {
      th.createSpan({ cls: "ogantt-sort-arrow", text: ctx.plugin.settings.sortDir === "asc" ? "↑" : "↓" });
    }
    th.onclick = () => ctx.toggleSort(id);
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
        ctx.autoFitColumn(id, nth, th);
        return;
      }
      lastDown = e.timeStamp;
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = ctx.colW(id);
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        moved = true;
        const w = Math.max(40, Math.round(startW + ev.clientX - startX));
        ctx.plugin.settings.columnWidths[id] = w;
        // ドラッグ中は再描画せず幅だけ反映 / live-apply widths without a full re-render
        grid.style.gridTemplateColumns = `${ctx.tableWidth()}px ${width}px`;
        if (id !== "name") {
          th.style.width = `${w}px`;
          body
            ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
            .forEach((el) => (el.style.width = `${w}px`));
        }
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        // 実際に動かしたときだけ保存（単押しでDOMを作り直さない＝2回押し判定を生かす）
        // save only after an actual drag (a plain press doesn't re-render, keeping double-press alive)
        if (moved) void ctx.plugin.saveSettings();
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // (2) 日付軸 / date axis
  // Fit は算出した ppd から目盛り粒度を選ぶ / in Fit, pick tick granularity from the computed ppd
  const tickZoom: ZoomMode =
    ctx.zoom !== "Fit" ? ctx.zoom : ctx.ppd >= 24 ? "Day" : ctx.ppd >= 10 ? "Week" : "Month";
  const axis = grid.createDiv({ cls: "ogantt-axis" });
  for (const tick of buildTicks(ctx.range, tickZoom, ctx.ppd)) {
    const t = axis.createDiv({ cls: "ogantt-tick" + (tick.major ? " is-major" : "") });
    t.style.left = `${tick.x}px`;
    t.setText(tick.label);
  }

  // (3) 表の本体 / table body
  const body = grid.createDiv({ cls: "ogantt-tbody" });
  ctx.setTbodyEl(body);
  for (const row of ctx.rows) {
    const tr = body.createDiv({ cls: "ogantt-tr" });
    tr.style.height = `${ROW_H}px`;
    const indent = 8 + Math.min(row.depth, MAX_INDENT_DEPTH) * 16; // 入れ子インデント（上限あり）/ nesting indent (capped)
    if (row.kind === "group") {
      tr.addClass("is-group");
      const isCollapsed = row.key != null && ctx.collapsed.has(row.key);
      const g = tr.createDiv({ cls: "ogantt-td-group" });
      g.style.paddingLeft = `${indent}px`;
      const chev = g.createSpan({ cls: "ogantt-chevron" });
      setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
      const ic = g.createSpan({ cls: "ogantt-folder-icon" });
      // タググループはタグアイコン、それ以外はフォルダ / a tag icon for tag groups, folder otherwise
      setIcon(ic, ctx.groupBy === "tag" ? "tag" : isCollapsed ? "folder" : "folder-open");
      // 見出しアイコンに色（フォルダ＝フォルダ色、タグ＝タグ色。(なし) は既定色のまま）
      // tint the heading icon (folder color / tag color; leave the (none) group default)
      if (ctx.groupBy === "folder" && row.key != null) ic.style.color = folderColor(ctx.plugin.settings, row.group);
      else if (ctx.groupBy === "tag" && row.group !== strings.noneLabel) ic.style.color = tagColor(ctx.plugin.settings, row.group);
      g.createSpan({ text: row.group });
      // 見出しを右クリック＝色を変更（フォルダ／タグ。(なし) は除く）/ right-click a heading to change its color
      if (ctx.groupBy === "folder" && row.key != null) {
        g.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const folderPath = ctx.folder ? `${ctx.folder}/${row.key}` : (row.key ?? "");
          const m = new Menu();
          m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void ctx.createTaskInFolder(folderPath)));
          m.addSeparator();
          m.addItem((i) => i.setTitle(strings.menuChangeColor).setIcon("palette").onClick(() => ctx.openColorMenu(e, "folder", row.group)));
          m.showAtMouseEvent(e);
        });
      } else if (ctx.groupBy === "tag" && row.group !== strings.noneLabel) {
        g.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const m = new Menu();
          m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void ctx.createTaskInFolder(ctx.folder)));
          m.addSeparator();
          m.addItem((i) => i.setTitle(strings.menuChangeColor).setIcon("palette").onClick(() => ctx.openColorMenu(e, "tag", row.group)));
          m.showAtMouseEvent(e);
        });
      } else if (row.kind === "group") {
        g.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const m = new Menu();
          m.addItem((i) => i.setTitle(strings.menuAddTask).setIcon("plus-circle").onClick(() => void ctx.createTaskInFolder(ctx.folder)));
          m.showAtMouseEvent(e);
        });
      }
      tr.onclick = () => {
        if (row.key == null) return;
        if (ctx.collapsed.has(row.key)) ctx.collapsed.delete(row.key);
        else ctx.collapsed.add(row.key);
        void ctx.refresh();
      };
      // フォルダグループへドロップ＝親を解除してそのフォルダのトップレベルへ / drop onto a folder = detach + move to its top level
      if (ctx.groupBy === "folder" && row.key != null) {
        const dest = ctx.folder ? `${ctx.folder}/${row.key}` : row.key;
        ctx.makeDropTarget(tr, (src) => void ctx.reparentTo(src, dest, null));
      }
      // タググループへドロップ＝そのタグを付与（(なし) グループは対象外）/ drop onto a tag group = add that tag (skip the (none) group)
      if (ctx.groupBy === "tag" && row.key != null && row.group !== strings.noneLabel) {
        const tag = row.key;
        ctx.makeDropTarget(tr, (src) => void ctx.addTagTo(src, tag));
      }
    } else {
      const t = row.task!;
      tr.setAttr("data-path", t.path);
      if (t.path === ctx.selectedPath) tr.addClass("is-selected");
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
            setIcon(chev, ctx.collapsed.has(key) ? "chevron-right" : "chevron-down");
            chev.addClass("is-clickable");
            chev.addEventListener("click", (e) => {
              e.stopPropagation(); // 行クリック（詳細を開く）を抑止 / don't open the detail panel
              if (ctx.collapsed.has(key)) ctx.collapsed.delete(key);
              else ctx.collapsed.add(key);
              void ctx.refresh();
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
                await renameTask(ctx.app, task.path, newName);
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
            m.addItem((i) => i.setTitle(strings.menuAddSubtask).setIcon("plus-circle").onClick(() => void ctx.createSubtask(t.path)));
            m.addItem((i) => i.setTitle(strings.menuDelete).setIcon("trash-2").onClick(() => ctx.confirmDelete(t.path)));
            m.showAtMouseEvent(e);
          });
        } else {
          const td = tr.createDiv({ cls: "ogantt-td" });
          td.style.width = `${ctx.colW(id)}px`;
          ctx.renderCell(td, row, id);
        }
      }
      // シングルクリック＝詳細パネル、ダブルクリック＝ノートを新規タブで（バーと同じ挙動）
      // single click = detail panel; double click = open the note in a new tab (same as the bars)
      tr.addEventListener("click", (ev) => ctx.activateTask(t.path, ev));
      tr.addEventListener("dblclick", () => ctx.openTaskNote(t.path));
      if (ctx.groupBy === "folder") {
        ctx.makeDraggableTask(tr, t.path);
        // タスク行へドロップ＝そのタスクのサブタスクにする（親フォルダへ同居）/ drop onto a task = make it that task's subtask
        ctx.makeDropTarget(tr, (src) => void ctx.reparentTo(src, ctx.taskFolder(t.path), t.path));
      } else if (ctx.groupBy === "tag") {
        // タグ表示ではタググループへドラッグしてタグ付け（タスクへのドロップ＝サブタスク化はしない）
        // when grouping by tag, drag onto a tag group to tag (no subtask drop)
        ctx.makeDraggableTask(tr, t.path);
      }
    }
  }

  // (4) タイムライン SVG / timeline SVG
  const svgWrap = grid.createDiv({ cls: "ogantt-svgwrap" });
  const svg = svgWrap.createSvg("svg", { cls: "ogantt-svg" });
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(bodyH));
  drawGrid(ctx, svg, width, bodyH);
  // 依存作成ハンドルは専用レイヤーに集め、依存矢印より後に追加＝最前面で掴みやすい
  // collect connector handles in their own layer, appended after the arrows so they stay topmost and grabbable
  const handlesLayer = svgEl("g", { class: "ogantt-handles-layer" });
  drawBars(ctx, svg, handlesLayer);
  drawDependencies(ctx, svg); // バーの上に描いて矢印を隠さない / on top of bars so arrows stay visible
  svg.appendChild(handlesLayer); // 矢印の上にハンドルを重ねる / handles above arrows
  // タイムライン上の空白エリアのクリックで行選択＋ノートを開く（バーのクリックは個別に stopPropagation している）
  // click on empty timeline space = select + open note (bar clicks stopPropagation individually)
  svg.addEventListener("click", (ev) => {
    if (ev.detail > 1) return; // dblclick の後に来る click は無視 / skip the click that follows a dblclick
    const box = svg.getBoundingClientRect();
    const rowIdx = Math.floor((ev.clientY - box.top) / ROW_H);
    const row = ctx.rows[rowIdx];
    if (row?.kind === "task" && row.task) void ctx.openTaskInSidebar(row.task.path);
  });
  svg.addEventListener("dblclick", (ev) => {
    const box = svg.getBoundingClientRect();
    const rowIdx = Math.floor((ev.clientY - box.top) / ROW_H);
    const row = ctx.rows[rowIdx];
    if (row?.kind === "task" && row.task) ctx.openTaskNote(row.task.path);
  });
}

function xOf(ctx: ViewCtx, dateStr: string): number {
  return (dayIndex(dateStr) - ctx.range.min) * ctx.ppd;
}

function drawGrid(ctx: ViewCtx, svg: SVGElement, width: number, height: number): void {
  // 選択行のタイムライン側ハイライト（バーや線より前に追加＝最背面）/ selected-row highlight on the timeline side (added first = behind everything)
  ctx.rows.forEach((row, i) => {
    if (row.kind === "task" && row.task?.path === ctx.selectedPath) {
      svg.appendChild(svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-row-sel" }));
    }
  });
  // 行の区切り / row separators
  ctx.rows.forEach((row, i) => {
    if (row.kind === "group") {
      const bg = svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-grid-group" });
      svg.appendChild(bg);
    }
    const line = svgEl("line", { x1: 0, y1: (i + 1) * ROW_H, x2: width, y2: (i + 1) * ROW_H, class: "ogantt-grid-row" });
    svg.appendChild(line);
  });
  // 今日の線 / today marker
  const todayX = (todayIndex() - ctx.range.min) * ctx.ppd;
  if (todayX >= 0 && todayX <= width) {
    svg.appendChild(svgEl("line", { x1: todayX, y1: 0, x2: todayX, y2: height, class: "ogantt-today" }));
  }
}

function drawBars(ctx: ViewCtx, svg: SVGElement, handlesLayer: SVGElement): void {
  const statusColor = new Map(ctx.plugin.settings.statuses.map((s) => [s.id, s.color]));
  ctx.rows.forEach((row, i) => {
    // グループ行のまとめバー / group summary bar
    if (row.kind === "group") {
      if (!row.span) return;
      const gx = xOf(ctx, row.span.start);
      const gw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * ctx.ppd, 6);
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
    if (ctx.rollup && row.span) {
      const sx = xOf(ctx, row.span.start);
      const sw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * ctx.ppd, 6);
      const yy = i * ROW_H + BAR_PAD;
      const hh = ROW_H - BAR_PAD * 2;
      const c =
        ctx.colorBy === "assignee"
          ? t.assignee ? hashColor(t.assignee) : FALLBACK_BAR
          : (t.status && statusColor.get(t.status)) || FALLBACK_BAR;
      const rg = svgEl("g", { class: "ogantt-bar-g ogantt-rollup-g", "data-path": t.path }) as SVGGElement;
      rg.appendChild(svgEl("rect", { x: sx, y: yy, width: sw, height: hh, rx: 4, class: "ogantt-bar ogantt-rollup-bar", fill: c }));
      const sdays = dayIndex(row.span.end) - dayIndex(row.span.start) + 1;
      drawBarLabel(ctx.measurer, rg, sx, sw, i * ROW_H + ROW_H / 2, sdays, t.name);
      rg.addEventListener("click", (ev) => { ev.stopPropagation(); ctx.activateTask(t.path, ev); });
      rg.addEventListener("dblclick", (ev) => { ev.stopPropagation(); ctx.openTaskNote(t.path); });
      svg.appendChild(rg);
      return;
    }
    const aStart = anchorStart(t);
    if (!aStart) return;
    const y = i * ROW_H + BAR_PAD;
    const h = ROW_H - BAR_PAD * 2;
    const x = xOf(ctx, aStart);
    const color =
      ctx.colorBy === "assignee"
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
      attachDrag(ctx, g, dia, t);
      lx = cx - r;
      rx = cx + r;
    } else {
      const endStr = anchorEnd(t) ?? aStart;
      const w = Math.max((dayIndex(endStr) - dayIndex(aStart) + 1) * ctx.ppd, 6);
      const rect = svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar", fill: color });
      g.appendChild(rect);
      if (t.progress != null && t.progress > 0) {
        const pw = (w * Math.min(100, t.progress)) / 100;
        g.appendChild(svgEl("rect", { x, y, width: pw, height: h, rx: 4, class: "ogantt-bar-progress" }));
      }
      // バー内ラベル：左から「期間 名前」。名前はバー幅に収まる分だけ … で省略 / in-bar label "<days>d  <name>", name truncated with … to fit
      const days = dayIndex(endStr) - dayIndex(aStart) + 1;
      drawBarLabel(ctx.measurer, g, x, w, cyText(i), days, t.name);
      attachDrag(ctx, g, rect, t);
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
      handle.addEventListener("pointerdown", (e: PointerEvent) => startLink(ctx, g, svg, t, end, e));
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
      if (ctx.dragged.get(g)) return; // ドラッグだった＝開かない / it was a drag, not a click
      ctx.activateTask(t.path, ev);
    });
    g.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      ctx.openTaskNote(t.path);
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
function startLink(ctx: ViewCtx, g: SVGGElement, svg: SVGElement, source: Task, sourceEnd: "start" | "finish", ev: PointerEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  ctx.dragged.set(g, true); // バーのクリックを抑止 / suppress the bar click
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
    const row = ctx.rows[Math.floor(y2 / ROW_H)];
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
    window.setTimeout(() => ctx.dragged.set(g, false), 0);
    const row = ctx.rows[Math.floor((e.clientY - box.top) / ROW_H)];
    if (row?.kind === "task" && row.task && row.task.path !== source.path) {
      const target = row.task;
      // ドロップ先のどの端か判定（左半分=start, 右半分=finish）/ which end was dropped on
      const tLeft = xOf(ctx, anchorStart(target) ?? anchorEnd(target)!);
      const tRight = xOf(ctx, anchorEnd(target) ?? anchorStart(target)!) + ctx.ppd;
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
        await ctx.pushUndo(tr().undoAddDep(type));
        await addDependency(ctx.app, ctx.plugin.settings, target.path, source.path, type);
        // メモリにも依存を反映（metadataCache 更新前でも整列できるように）/ reflect dep in-memory
        target.deps = target.deps.filter((dd) => dd.path !== source.path);
        target.deps.push({ path: source.path, type });
        // SS/FF は後続の日付を先行に揃える（連鎖も）/ snap SS/FF successors to the predecessor
        await realignSuccessors(ctx, source.path);
        ctx.rerender();
      }
    }
  })();
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
}

function drawDependencies(ctx: ViewCtx, svg: SVGElement): void {
  const rowOf = new Map<string, number>();
  ctx.rows.forEach((r, i) => {
    if (r.kind === "task") rowOf.set(r.task!.path, i);
  });
  const GAP = 12;
  for (const t of ctx.tasks) {
    const si = rowOf.get(t.path);
    if (si == null) continue;
    const sStart = anchorStart(t);
    const sEnd = anchorEnd(t);
    if (!sStart || !sEnd) continue;
    const sLeft = xOf(ctx, sStart);
    const sRight = xOf(ctx, sEnd) + ctx.ppd;
    const sy = si * ROW_H + ROW_H / 2;

    for (const dep of t.deps) {
      const pi = rowOf.get(dep.path);
      const pred = ctx.tasks.find((x) => x.path === dep.path);
      if (pi == null || !pred) continue;
      const pStartD = anchorStart(pred);
      const pEndD = anchorEnd(pred);
      if (!pStartD || !pEndD) continue;
      const pLeft = xOf(ctx, pStartD);
      const pRight = xOf(ctx, pEndD) + ctx.ppd;
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
        await ctx.pushUndo(tr().undoRemoveDep(depType));
        await removeDependency(ctx.app, ctx.plugin.settings, succPath, predPath);
        await ctx.refresh();
      })());
      svg.appendChild(depG);
    }
  }
}

// ドラッグ中にバー内ラベル（期間＋名前）を丸ごと再描画。静的描画と同じ drawBarLabel を使うのでズレない
// redraw the whole in-bar label (duration + name) while dragging; reuses drawBarLabel so it matches the static render exactly
function liveBarLabel(ctx: ViewCtx, g: SVGGElement, rect: SVGElement, x: number, w: number, days: number, name: string): void {
  g.querySelectorAll(".ogantt-bar-intext").forEach((el) => el.remove());
  const cy = parseFloat(rect.getAttribute("y")!) + parseFloat(rect.getAttribute("height")!) / 2;
  drawBarLabel(ctx.measurer, g, x, w, cy, days, name);
}

// バー/菱形のドラッグで日付を書き戻す / drag a bar or diamond to reschedule
function attachDrag(ctx: ViewCtx, g: SVGGElement, handle: SVGElement, task: Task): void {
  const EDGE = RESIZE_EDGE;
  const milestone = task.milestone;
  handle.addEventListener("pointerdown", (ev: PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    // preventDefault はフォーカスを移さないため、入力中の欄を明示的に外す（Ctrl+Z をガント側へ）
    // preventDefault keeps focus on a previously focused input; blur it so Ctrl+Z reaches the gantt undo
    (activeDocument.activeElement as HTMLElement | null)?.blur?.();
    ctx.dragged.set(g, false);
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
      if (Math.abs(dx) > 3) ctx.dragged.set(g, true);
      if (milestone) {
        g.setAttribute("transform", `translate(${dx},0)`);
        return;
      }
      if (mode === "move") handle.setAttribute("x", String(x0 + dx));
      else if (mode === "r") handle.setAttribute("width", String(Math.max(ctx.ppd, w0 + dx)));
      else {
        handle.setAttribute("x", String(x0 + dx));
        handle.setAttribute("width", String(Math.max(ctx.ppd, w0 - dx)));
      }
      // バー内ラベル（期間＋名前）と全体進捗をライブ更新 / live-update the in-bar label (duration + name) and overall progress
      const nx = parseFloat(handle.getAttribute("x")!);
      const nw = parseFloat(handle.getAttribute("width")!);
      const days = Math.max(1, Math.round(nw / ctx.ppd));
      liveBarLabel(ctx, g, handle, nx, nw, days, task.name);
      ctx.updateProjectProgress({ path: task.path, days });
    };
    const onUp = (e: PointerEvent) => void (async () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      const dxDays = Math.round((e.clientX - startX) / ctx.ppd);
      if (dxDays !== 0) {
        await ctx.pushUndo(tr().undoReschedule(task.name));
        if (milestone) {
          const nd = dayToStr(dayIndex(task.end ?? task.start!) + dxDays);
          await writeDates(ctx.app, ctx.plugin.settings, task.path, nd, nd, true);
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
          await writeDates(ctx.app, ctx.plugin.settings, task.path, nsS, neS, false);
          task.start = nsS; // メモリ更新 / update in-memory
          task.end = neS;
        }
        // SS/FF 後続を連動（メモリ更新＋ディスク書き込み）/ cascade to SS/FF successors
        await realignSuccessors(ctx, task.path);
        // メモリから即再描画（ディスク再読込前に正しい位置を表示）/ render from memory for instant correct positions
        ctx.rerender();
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
          liveBarLabel(ctx, g, handle, x0, w0, Math.max(1, Math.round(w0 / ctx.ppd)), task.name);
          ctx.updateProjectProgress();
        }
      }
    })();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}
