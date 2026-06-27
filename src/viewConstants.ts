// Layout and column constants shared by the board view and its renderers.

export const ROW_H = 30; // shared row height (table + timeline)
export const HEAD_H = 40; // header height
export const BAR_PAD = 6; // vertical padding inside a row
export const RESIZE_EDGE = 8; // edge-resize hit width on a bar
export const MIN_PPD = 2; // minimum px/day in Fit mode (below this, scroll horizontally)
export const MAX_PPD = 48; // max px/day for smooth wheel zoom
export const FALLBACK_BAR = "#7c8db5"; // bar color when status/assignee is unset

// Table column definitions.
// `name` is always shown and flexes; the rest are toggleable with a fixed width.
export type ColumnId = "name" | "start" | "end" | "assignee" | "status" | "tags";
export const COLUMN_ORDER: ColumnId[] = ["name", "start", "end", "assignee", "status", "tags"];
export const OPTIONAL_COLUMNS: ColumnId[] = ["start", "end", "assignee", "status", "tags"]; // toggleable columns
export const COLUMN_WIDTHS: Record<ColumnId, number> = { name: 160, start: 84, end: 84, assignee: 96, status: 96, tags: 140 };
export const MAX_INDENT_DEPTH = 8; // visual indent cap (the tree itself is unlimited)
