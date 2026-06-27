import { Task, DepType } from "../types";
import { anchorStart, anchorEnd, writeDates } from "../model";
import { dayIndex, dayToStr } from "../timeline";
import { ViewCtx } from "./context";

// Align a successor to its predecessor per SS/FF/FS (duration kept → the bar moves).
// Returns true if the successor's dates actually changed.
export async function applyAlign(ctx: ViewCtx, target: Task, pred: Task, type: DepType): Promise<boolean> {
  // Milestones are fixed dates: never auto-moved.
  if (target.milestone) return false;
  const ps = anchorStart(pred);
  const pe = anchorEnd(pred);
  let ns: string | undefined;
  let ne: string | undefined;
  if (type === "FS") {
    // Successor starts the day after the predecessor's end.
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

  // Skip if unchanged.
  if (target.milestone) {
    if (target.end === ne) return false;
  } else if (target.start === ns && target.end === ne) {
    return false;
  }
  await writeDates(ctx.app, ctx.plugin.settings, target.path, ns, ne, target.milestone);
  // Update in-memory too, so cascading alignment sees the new dates.
  if (target.milestone) target.end = ne;
  else {
    target.start = ns;
    target.end = ne;
  }
  return true;
}

// Realign a task's SS/FF successors, propagating along chains (cycles stopped via `seen`).
export async function realignSuccessors(ctx: ViewCtx, rootPath: string): Promise<boolean> {
  const queue = [rootPath];
  const seen = new Set<string>();
  let any = false;
  let guard = 0;
  while (queue.length && guard++ < 1000) {
    const predPath = queue.shift()!;
    const pred = ctx.tasks.find((t) => t.path === predPath);
    if (!pred) continue;
    for (const succ of ctx.tasks) {
      if (succ.path === predPath) continue;
      const dep = succ.deps.find((dd) => dd.path === predPath);
      if (!dep) continue;
      if (await applyAlign(ctx, succ, pred, dep.type)) {
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
