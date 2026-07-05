// pure task ⇄ Google Calendar event mapping logic (no side effects; unit-tested)

import { combineDateTime, parseStored } from "../model";
import type { GEvent } from "./api";

// the task fields the mapping needs
export interface TaskLike {
  path: string;
  name: string;
  start?: string;
  end?: string;
  startTime?: string;
  endTime?: string;
  milestone: boolean;
}

// add days to an ISO date
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// wall-clock in the configured tz → RFC3339 (with seconds)
export function rfc3339(date: string, time: string, tz: string): string {
  // combineDateTime returns "YYYY-MM-DDTHH:mm+09:00", so insert the seconds Google requires
  return combineDateTime(date, time, tz)!.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/, "$1:00");
}

// syncable = the task has at least one date
export function hasDates(t: TaskLike): boolean {
  return !!(t.start ?? t.end);
}

// fingerprint of the local content; equal hashes skip the API call (gcalId itself is excluded)
export function taskHash(t: TaskLike, excerpt: string): string {
  const s = JSON.stringify([t.name, t.start, t.end, t.startTime, t.endTime, t.milestone, excerpt]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + s.length.toString(36);
}

// build the event start/end; the unused variant is an explicit null so PATCH can flip all-day ⇄ timed
export function eventTimes(
  t: TaskLike,
  tz: string
): { start: { date: string | null; dateTime: string | null }; end: { date: string | null; dateTime: string | null } } {
  const allDay = (s: string, e: string) => ({
    start: { date: s, dateTime: null },
    // the all-day end.date is exclusive
    end: { date: addDays(e, 1), dateTime: null },
  });
  if (t.milestone) {
    const d = (t.end ?? t.start)!;
    const time = t.endTime;
    if (!time) return allDay(d, d);
    const v = rfc3339(d, time, tz);
    return { start: { dateTime: v, date: null }, end: { dateTime: v, date: null } };
  }
  const start = t.start!;
  const end = t.end ?? start;
  // timed only when both ends have a time; a one-sided time is treated as all-day
  if (t.startTime && t.endTime) {
    return {
      start: { dateTime: rfc3339(start, t.startTime, tz), date: null },
      end: { dateTime: rfc3339(end, t.endTime, tz), date: null },
    };
  }
  return allDay(start, end);
}

// task → event payload
export function buildEvent(t: TaskLike, tz: string, excerpt: string, vaultName: string): object {
  const noExt = t.path.replace(/\.md$/, "");
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(noExt)}`;
  return {
    summary: t.name,
    description: excerpt ? `${excerpt}\n\n${uri}` : uri,
    ...eventTimes(t, tz),
    extendedProperties: { private: { tgVault: vaultName, tgPath: t.path } },
  };
}

// event → local dates/times (display values in the configured tz); unparsable events → null
export function fromEvent(
  ev: GEvent,
  tz: string
): { start: string; end: string; startTime?: string; endTime?: string } | null {
  if (ev.start?.date && ev.end?.date) {
    // all-day: convert the exclusive end back to inclusive
    const end = addDays(ev.end.date, -1);
    return { start: ev.start.date, end: end < ev.start.date ? ev.start.date : end };
  }
  if (ev.start?.dateTime) {
    const ps = parseStored(ev.start.dateTime, tz);
    const pe = parseStored(ev.end?.dateTime ?? ev.start.dateTime, tz);
    if (!ps || !pe) return null;
    return { start: ps.date, end: pe.date, startTime: ps.time, endTime: pe.time };
  }
  return null;
}
