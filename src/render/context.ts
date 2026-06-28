import { App } from "obsidian";
import type GanttPlugin from "../main";
import { Task, Row, ZoomMode } from "../types";
import { DateRange } from "../timeline";
import { ColumnId } from "../viewConstants";

// The seam between GanttView and the render/* modules. The view builds one of these
// (live getters for mutable state, bound callbacks for the rest); the renderers draw
// and wire interactions through it without reaching into the view's private fields.
export interface ViewCtx {
  // Long-lived references.
  app: App;
  plugin: GanttPlugin;
  dragged: WeakMap<SVGGElement, boolean>; // bars dragged this gesture (suppresses the trailing click)

  // Live view state (getters, so handlers attached during a render always read current values).
  readonly range: DateRange;
  readonly ppd: number;
  readonly rows: Row[];
  readonly tasks: Task[];
  readonly zoom: ZoomMode;
  readonly groupBy: "folder" | "status" | "assignee" | "tag";
  readonly colorBy: "status" | "assignee";
  readonly folder: string;
  readonly rollup: boolean;
  readonly collapsed: Set<string>;
  readonly selectedPath: string | null;

  // Table helpers owned by the view.
  visibleColumns(): ColumnId[];
  tableWidth(): number;
  colW(id: ColumnId): number;
  colLabel(id: ColumnId): string;
  toggleSort(id: ColumnId): void;
  autoFitColumn(id: ColumnId, nth: number, th: HTMLElement): void;
  setTbodyEl(el: HTMLElement): void;

  // Drag & drop / task mutations owned by the view.
  makeDraggableTask(row: HTMLElement, path: string): void;
  makeDropTarget(row: HTMLElement, handler: (srcPath: string) => void): void;
  taskFolder(path: string): string;
  reparentTo(srcPath: string, destFolder: string, parentTaskPath: string | null): Promise<void>;
  addTagTo(srcPath: string, tag: string): Promise<void>;
  createTaskInFolder(folderPath: string): Promise<void>;
  createSubtask(parentPath: string): Promise<void>;
  confirmDelete(path: string): void;
  openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void;

  // Selection / navigation.
  activateTask(path: string, ev: MouseEvent): void;
  openTaskNote(path: string): void;
  openTaskInSidebar(path: string): Promise<void>;

  // Lifecycle / feedback.
  refresh(): Promise<void>;
  rerender(): void;
  pushUndo(label: string): Promise<void>;
  updateProjectProgress(override?: { path: string; days: number }): void;
}
