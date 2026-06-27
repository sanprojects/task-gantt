// Core data types

// Status definition (customizable in settings)
export interface StatusDef {
  id: string; // matches the `status` frontmatter value
  label: string;
  color: string; // bar color (CSS color)
}

// dependency type (SF unsupported)
export type DepType = "FS" | "SS" | "FF";

// a dependency: predecessor path + type
export interface Dep {
  path: string; // resolved predecessor path
  type: DepType;
}

// one file = one task
export interface Task {
  path: string; // file path (unique key)
  name: string; // basename without extension
  groups: string[]; // folder chain relative to the scope
  start?: string; // YYYY-MM-DD
  end?: string; // YYYY-MM-DD
  // optional time of day, set when frontmatter is "YYYY-MM-DDTHH:mm"; layout stays day-based
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
  status?: string; // references StatusDef.id
  assignee?: string;
  deps: Dep[]; // resolved dependencies on predecessors
  progress?: number; // 0-100
  milestone: boolean;
  parent?: string; // resolved parent task path
  tags: string[]; // tags (without #, frontmatter + inline)
}

// a display row
export interface Row {
  kind: "group" | "task";
  group: string; // folder name for group rows
  depth: number; // nesting depth for indentation
  key?: string; // unique folder key for collapse state
  task?: Task;
  // rolled-up span for a group or parent-task row
  span?: { start: string; end: string };
  hasChildren?: boolean; // a parent task row (has subtasks)
}

// state passed to the dedicated view
export interface GanttViewState {
  folder: string; // scoped folder path ("" = vault root)
  // view options + filters, persisted across reloads/restarts
  colorBy?: "status" | "assignee";
  groupBy?: "folder" | "status" | "assignee" | "tag";
  filterAssignee?: string;
  filterTag?: string;
  hiddenStatuses?: string[]; // statuses dropped in the legend
  flat?: boolean;
  showEmptyFolders?: boolean;
  rollup?: boolean;
  zoom?: ZoomMode;
  // saved only during a manual (wheel) zoom: the free px/day and the left-edge day. Not stored for presets/Fit.
  customPpd?: number | null;
  scrollDay?: number;
}

export const VIEW_TYPE_GANTT = "task-gantt-view";
// Fit = auto-scale to the pane width
export type ZoomMode = "Day" | "Week" | "Month" | "Fit";

// display-only date format (stored value stays ISO)
export type DateFormat = "YYYY/MM/DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
