import { App, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import { GanttSettings } from "./settings";
import { Task, Row, Dep, DepType, StatusDef } from "./types";
import { pad2 } from "./timeline";

// split a raw `after` entry into type + link
function parseDepRaw(raw: string): { type: DepType; link: string } {
  const m = raw.match(/^\s*(FS|SS|FF)\s*:\s*(.*)$/i);
  if (m) return { type: m[1].toUpperCase() as DepType, link: m[2].trim() };
  return { type: "FS", link: raw.trim() };
}

// strip the type prefix, keep the link
function stripDepType(raw: unknown): string {
  return String(raw).replace(/^\s*(FS|SS|FF)\s*:\s*/i, "");
}

// configured timezone offset in minutes; "system" = device offset at that instant (DST-aware)
function offsetMinutes(tz: string, instantMs: number): number {
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (m) return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return -new Date(instantMs).getTimezoneOffset();
}

// minutes to a "+09:00" suffix
function offsetSuffix(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// parse a stored value into display date + time: zoned values convert to the configured tz,
// naive values pass through, non-date values (e.g. the example value) become undefined
export function parseStored(v: unknown, tz: string): { date: string; time?: string } | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) v = v.toISOString();
  const m = String(v)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return undefined;
  const [, date, h, mi, zone] = m;
  if (h == null) return { date };
  const hh = +h;
  const mm = +mi;
  if (hh > 23 || mm > 59) return { date }; // invalid time → date only
  if (!zone) return { date, time: `${pad2(hh)}:${pad2(mm)}` };
  const zu = zone.toUpperCase();
  const zMin = zu === "Z" ? 0 : (zu[0] === "-" ? -1 : 1) * (+zu.slice(1, 3) * 60 + +zu.replace(":", "").slice(-2));
  const [y, mo, d] = date.split("-").map(Number);
  const instant = Date.UTC(y, mo - 1, d, hh, mm) - zMin * 60000;
  const disp = new Date(instant + offsetMinutes(tz, instant) * 60000).toISOString();
  return { date: disp.slice(0, 10), time: disp.slice(11, 16) };
}

// wall-clock date + time in the configured tz → absolute epoch ms (used for notification triggers)
export function toInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  const off = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : -new Date(`${date}T${time}`).getTimezoneOffset();
  return naive - off * 60000;
}

// combine display date + time into the stored value (a time gets the configured tz offset appended)
export function combineDateTime(date: string | undefined, time: string | undefined, tz: string): string | undefined {
  if (!date) return undefined;
  if (!time) return date;
  // "system" = device offset at that wall time (DST-aware)
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  const min = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : -new Date(`${date}T${time}`).getTimezoneOffset();
  return `${date}T${time}${offsetSuffix(min)}`;
}

// normalize `after` into a string array
function toArray(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

// normalize a frontmatter `tags` value into a string array (array / comma / space separated, # stripped)
function normalizeTags(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(/[,\s]+/);
  return raw.map((x) => x.replace(/^#/, "").trim()).filter(Boolean);
}

// resolve a wikilink, markdown link, or raw path
function resolveLink(app: App, raw: string, sourcePath: string): TFile | null {
  let inner = raw.trim();
  const md = inner.match(/\]\(([^)]+)\)/); // [text](path)
  if (md) inner = decodeURIComponent(md[1]);
  else inner = inner.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  inner = inner.split("#")[0].trim();
  return app.metadataCache.getFirstLinkpathDest(inner, sourcePath);
}

// collect tasks under a scoped folder
export function collectTasks(app: App, settings: GanttSettings, folderPath: string): Task[] {
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();

  const files: TFile[] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") files.push(child);
      else if (child instanceof TFolder && settings.recurse) walk(child);
    }
  };
  walk(root);

  const k = settings.keys;
  const rawAfter = new Map<string, string[]>(); // path -> raw after entries
  const rawParent = new Map<string, string>(); // path -> raw parent link
  const tasks: Task[] = files.map((file) => {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? {};
    // merge frontmatter + inline tags, strip #, dedupe
    const tags = cache ? [...new Set((getAllTags(cache) ?? []).map((x) => x.replace(/^#/, "")))] : [];
    // folder chain relative to the scope (without filename)
    const rel = isVaultRoot ? file.path : file.path.slice(rootPath.length + 1);
    const segs = rel.split("/");
    const groups = segs.slice(0, -1);

    const ps = parseStored(fm[k.start], settings.tz);
    const pe = parseStored(fm[k.end], settings.tz);
    const start = ps?.date;
    let end = pe?.date;
    // milestone = only the due date, or explicit flag
    const milestone = fm[k.milestone] === true || (!!end && !start);
    // "start only" isn't valid: mirror end = start
    if (start && !end) end = start;

    rawAfter.set(file.path, toArray(fm[k.after]));
    // coerce parent via unknown (avoid unsafe any)
    const pv: unknown = fm[k.parent];
    if (pv != null && pv !== "") {
      const link = Array.isArray(pv) ? (pv as unknown[])[0] : pv;
      rawParent.set(file.path, String(link));
    }
    return {
      path: file.path,
      name: file.basename,
      groups,
      start,
      end,
      startTime: ps?.time,
      endTime: pe?.time,
      status: fm[k.status] != null ? String(fm[k.status]) : undefined,
      assignee: fm[k.assignee] != null ? String(fm[k.assignee]) : undefined,
      deps: [] as Dep[],
      progress: fm[k.progress] != null ? Number(fm[k.progress]) : undefined,
      milestone,
      parent: undefined,
      tags,
    };
  });

  // resolve typed dependencies to paths
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  for (const t of tasks) {
    for (const raw of rawAfter.get(t.path) ?? []) {
      const { type, link } = parseDepRaw(raw);
      const dest = resolveLink(app, link, t.path);
      if (dest && byPath.has(dest.path)) t.deps.push({ path: dest.path, type });
    }
    // resolve parent (unresolved = treated as top-level)
    const rp = rawParent.get(t.path);
    if (rp) {
      const dest = resolveLink(app, rp, t.path);
      if (dest && dest.path !== t.path && byPath.has(dest.path)) t.parent = dest.path;
    }
  }
  return tasks;
}

// collect all subfolders under the scope as relative segment arrays (used to show empty folders)
export function collectFolders(app: App, settings: GanttSettings, folderPath: string): string[][] {
  if (!settings.recurse) return []; // no grouping when not recursing
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();
  const out: string[][] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const rel = isVaultRoot ? child.path : child.path.slice(rootPath.length + 1);
      out.push(rel.split("/"));
      walk(child);
    }
  };
  walk(root);
  return out;
}

// task anchor dates (milestone collapses to its due date)
export function anchorStart(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.start;
}
export function anchorEnd(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.end ?? t.start;
}

// Apply the active filters and remap groups for the current grouping mode (pure; for display).
// Returns the task list to feed buildRows. "folder" grouping and flat mode keep the original
// groups; status/assignee collapse into one synthetic group; tag duplicates a task per tag.
export function processTasks(
  tasks: Task[],
  opts: {
    filterAssignee: string;
    filterTag: string;
    hiddenStatuses: Set<string>;
    groupBy: "folder" | "status" | "assignee" | "tag";
    flat: boolean;
    statuses: StatusDef[];
    noneLabel: string;
  }
): Task[] {
  let list = tasks;
  if (opts.hiddenStatuses.size) list = list.filter((t) => !opts.hiddenStatuses.has(t.status ?? ""));
  if (opts.filterAssignee) list = list.filter((t) => (t.assignee ?? "") === opts.filterAssignee);
  if (opts.filterTag) list = list.filter((t) => t.tags.includes(opts.filterTag));
  // flat ignores groups: skip remap (also avoids tag-duplicated rows)
  if (opts.groupBy === "folder" || opts.flat) return list;
  const none = opts.noneLabel;
  // tags are multi-valued: duplicate a task into each tag's group (untagged goes to "none")
  if (opts.groupBy === "tag") {
    const out: Task[] = [];
    for (const t of list) {
      if (t.tags.length === 0) out.push({ ...t, groups: [none] });
      else for (const tag of t.tags) out.push({ ...t, groups: [tag] });
    }
    return out;
  }
  // remap groups to a single synthetic group to reuse buildRows
  const statusLabel = new Map(opts.statuses.map((s) => [s.id, s.label]));
  return list.map((t) => {
    const key =
      opts.groupBy === "status"
        ? t.status ? statusLabel.get(t.status) ?? t.status : none
        : t.assignee || none;
    return { ...t, groups: [key] };
  });
}

// folder tree node
interface TreeNode {
  name: string;
  folders: Map<string, TreeNode>;
  tasks: Task[];
}

// all descendant tasks
function descendantTasks(node: TreeNode): Task[] {
  const out = [...node.tasks];
  for (const c of node.folders.values()) out.push(...descendantTasks(c));
  return out;
}

// compute the rolled-up span
function spanOf(tasks: Task[]): { start: string; end: string } | undefined {
  const starts = tasks.map(anchorStart).filter((d): d is string => !!d).sort();
  const ends = tasks.map(anchorEnd).filter((d): d is string => !!d).sort();
  return starts.length && ends.length ? { start: starts[0], end: ends[ends.length - 1] } : undefined;
}

// flatten the folder tree into nested rows (collapsed folders hide their children)
// default task order = start ascending
const defaultTaskCompare = (a: Task, b: Task): number =>
  (anchorStart(a) ?? "9999").localeCompare(anchorStart(b) ?? "9999");

export function buildRows(
  tasks: Task[],
  collapsed: Set<string> = new Set(),
  folders: string[][] = [],
  taskCompare: (a: Task, b: Task) => number = defaultTaskCompare,
  nest = false // nest by parent (folder grouping only)
): Row[] {
  const root: TreeNode = { name: "", folders: new Map(), tasks: [] };
  // seed nodes for (possibly empty) folders first, so a folder shows even with no tasks
  for (const chain of folders) {
    let node = root;
    for (const g of chain) {
      if (!g) continue;
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
  }
  for (const t of tasks) {
    let node = root;
    for (const g of t.groups) {
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
    node.tasks.push(t);
  }

  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number, prefix: string) => {
    // folders first, sorted by name
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
      const child = node.folders.get(name)!;
      const key = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "group", group: name, depth, key, span: spanOf(descendantTasks(child)) });
      if (!collapsed.has(key)) walk(child, depth + 1, key);
    }
    // place direct tasks (a parent forest when nesting)
    if (!nest) {
      const list = node.tasks.slice().sort(taskCompare);
      for (const task of list) rows.push({ kind: "task", group: node.name, depth, task });
      return;
    }
    // ── nest by parent within this folder ──
    const paths = new Set(node.tasks.map((t) => t.path));
    const childrenOf = (p: string): Task[] =>
      node.tasks.filter((t) => t.parent === p).sort(taskCompare);
    // self + descendants span (for rollup)
    const subtree = (t: Task, seen: Set<string>): Task[] => {
      if (seen.has(t.path)) return [];
      seen.add(t.path);
      const out = [t];
      for (const c of childrenOf(t.path)) out.push(...subtree(c, seen));
      return out;
    };
    // roots = no parent or parent not in this folder
    const roots = node.tasks.filter((t) => !t.parent || !paths.has(t.parent)).sort(taskCompare);
    // tasks that belong to the forest (ignoring collapse)
    const reachable = new Set<string>();
    const mark = (p: string) => {
      if (reachable.has(p)) return;
      reachable.add(p);
      for (const c of childrenOf(p)) mark(c.path);
    };
    for (const r of roots) mark(r.path);

    const emitted = new Set<string>();
    const emit = (task: Task, d: number) => {
      if (emitted.has(task.path)) return; // dup guard
      emitted.add(task.path);
      const kids = childrenOf(task.path);
      const has = kids.length > 0;
      const span = has ? spanOf(subtree(task, new Set())) : undefined;
      rows.push({ kind: "task", group: node.name, depth: d, task, key: has ? task.path : undefined, span, hasChildren: has });
      // hide children while collapsed
      if (has && !collapsed.has(task.path)) for (const c of kids) emit(c, d + 1);
    };
    for (const r of roots) emit(r, depth);
    // surface only cycle-orphaned tasks
    for (const t of node.tasks.slice().sort(taskCompare)) if (!reachable.has(t.path)) emit(t, depth);
  };
  walk(root, 0, "");
  return rows;
}

// write back start/end into frontmatter
export async function writeDates(
  app: App,
  settings: GanttSettings,
  path: string,
  start: string,
  end: string,
  milestone: boolean
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    // carry the displayed time-of-day over to the new date (re-normalizing the offset to the configured tz)
    const ts = parseStored(fm[k.start], settings.tz)?.time;
    const te = parseStored(fm[k.end], settings.tz)?.time;
    if (milestone) {
      // milestone keeps only the due date
      fm[k.end] = combineDateTime(end, te, settings.tz);
      delete fm[k.start];
    } else {
      fm[k.start] = combineDateTime(start, ts, settings.tz);
      fm[k.end] = combineDateTime(end, te, settings.tz);
    }
  });
}

// write back an arbitrary frontmatter value
export async function writeField(
  app: App,
  path: string,
  key: string,
  value: unknown
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    if (value == null || value === "") delete fm[key];
    else fm[key] = value;
  });
}

// Persist a task's start/end from the editor: each date is combined with its optional time-of-day
// (a time gets the configured tz offset appended); an empty date clears the field.
export async function writeDateRange(
  app: App,
  settings: GanttSettings,
  path: string,
  start: string | undefined,
  startTime: string | undefined,
  end: string | undefined,
  endTime: string | undefined
): Promise<void> {
  const k = settings.keys;
  await writeField(app, path, k.start, combineDateTime(start || undefined, startTime, settings.tz));
  await writeField(app, path, k.end, combineDateTime(end || undefined, endTime, settings.tz));
}

// create a new task (.md with empty frontmatter) in the folder; de-duplicate the name with a counter
export async function createTask(app: App, folderPath: string, baseName: string): Promise<TFile | null> {
  const dir = normalizePath(folderPath || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  let name = baseName;
  let i = 1;
  while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${baseName} ${++i}`;
  // caller fills start/end
  const file = await app.vault.create(`${prefix}${name}.md`, "---\n---\n");
  return file instanceof TFile ? file : null;
}

// rename the task file (updates links)
export async function renameTask(app: App, path: string, newName: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const safe = newName.replace(/[\\/:*?"<>|]/g, "").trim();
  if (!safe) return null;
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const newPath = `${dir}${safe}.md`;
  if (newPath === path) return path;
  await app.fileManager.renameFile(file, newPath);
  return newPath;
}

// delete a task to the user's trash (recoverable)
export async function deleteTask(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  await app.fileManager.trashFile(file);
  return true;
}

// add a tag to frontmatter `tags` (deduped)
export async function addTag(app: App, path: string, tag: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  const clean = tag.replace(/^#/, "").trim();
  if (!clean) return false;
  let changed = false;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const cur = normalizeTags(fm.tags);
    if (!cur.includes(clean)) {
      cur.push(clean);
      fm.tags = cur;
      changed = true;
    }
  });
  return changed;
}

// paths of a task's subtree (self + descendants)
export function subtreePaths(tasks: Task[], rootPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
    for (const c of tasks) if (c.parent === p) visit(c.path);
  };
  visit(rootPath);
  return out;
}

// set/clear a task's parent and move its whole subtree into destFolder (the D&D core)
// returns moves and the src's old content (for undo)
export async function reparentTask(
  app: App,
  settings: GanttSettings,
  tasks: Task[],
  srcPath: string,
  destFolder: string,
  parentFile: TFile | null
): Promise<{ moves: { from: string; to: string }[]; oldContent: string } | null> {
  const src = app.vault.getAbstractFileByPath(srcPath);
  if (!(src instanceof TFile)) return null;
  const k = settings.keys;
  const oldContent = await app.vault.read(src); // pre-op snapshot
  // set (or clear) the parent link
  await app.fileManager.processFrontMatter(src, (fm: Record<string, unknown>) => {
    if (parentFile) fm[k.parent] = app.fileManager.generateMarkdownLink(parentFile, srcPath);
    else delete fm[k.parent];
  });
  // the subtree co-locates in one folder, so move all of it into destFolder
  const dir = normalizePath(destFolder || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  const moves: { from: string; to: string }[] = [];
  for (const p of subtreePaths(tasks, srcPath)) {
    const f = app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) continue;
    if (normalizePath(f.parent?.path ?? "/") === dir) continue; // already there
    let name = f.basename;
    let i = 1;
    while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${f.basename} ${++i}`;
    const np = `${prefix}${name}.md`;
    await app.fileManager.renameFile(f, np); // Obsidian updates links
    moves.push({ from: p, to: np });
  }
  return { moves, oldContent };
}

// add a typed dependency; replaces any existing dependency to the same predecessor
export async function addDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string,
  type: DepType
): Promise<boolean> {
  if (successorPath === predPath) return false;
  const succ = app.vault.getAbstractFileByPath(successorPath);
  const pred = app.vault.getAbstractFileByPath(predPath);
  if (!(succ instanceof TFile) || !(pred instanceof TFile)) return false;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(succ, (fm: Record<string, unknown>) => {
    const existing = fm[k.after];
    const arr: unknown[] = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
    // drop any existing entry to the same predecessor
    const kept = arr.filter(
      (raw) => resolveLink(app, stripDepType(raw), successorPath)?.path !== predPath
    );
    const link = app.fileManager.generateMarkdownLink(pred, successorPath);
    kept.push(type === "FS" ? link : `${type}:${link}`); // FS has no prefix for backward compatibility
    fm[k.after] = kept;
  });
  return true;
}

// remove a dependency
export async function removeDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string
): Promise<void> {
  const succ = app.vault.getAbstractFileByPath(successorPath);
  if (!(succ instanceof TFile)) return;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(succ, (fm: Record<string, unknown>) => {
    const existing = fm[k.after];
    if (existing == null) return;
    const list: unknown[] = Array.isArray(existing) ? existing : [existing];
    const filtered = list.filter(
      (raw) => resolveLink(app, stripDepType(raw), successorPath)?.path !== predPath
    );
    if (filtered.length) fm[k.after] = filtered;
    else delete fm[k.after];
  });
}
