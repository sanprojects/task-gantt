import { Notice, requestUrl } from "obsidian";
import type GanttPlugin from "./main";
import { collectTasks, toInstant } from "./model";
import { formatDate } from "./timeline";
import { t as tr } from "./i18n";

// lead time presets in minutes
export const LEADS: { id: string; minutes: number }[] = [
  { id: "1w", minutes: 7 * 24 * 60 },
  { id: "1d", minutes: 24 * 60 },
  { id: "1h", minutes: 60 },
  { id: "10m", minutes: 10 },
  { id: "0", minutes: 0 },
];

// display label for a lead id
export function leadLabel(id: string): string {
  const s = tr();
  switch (id) {
    case "1w": return s.leadWeek;
    case "1d": return s.leadDay;
    case "1h": return s.leadHour;
    case "10m": return s.lead10m;
    default: return s.leadNow;
  }
}

// send triggers that fell within (from, to]; only tasks with a time of day are notified
export async function checkNotifications(plugin: GanttPlugin, fromMs: number, toMs: number): Promise<void> {
  const s = plugin.settings;
  const n = s.notify;
  if (!n.discordWebhook && !n.slackWebhook) return;
  if (!n.leads.length || (!n.notifyStart && !n.notifyEnd)) return;
  // scan the whole vault regardless of the default-folder setting (only timed tasks notify, so no noise)
  const tasks = collectTasks(plugin.app, { ...s, recurse: true }, "");
  let dirty = false;
  for (const t of tasks) {
    const ends: { kind: "start" | "end"; date?: string; time?: string; on: boolean }[] = [
      { kind: "start", date: t.start, time: t.startTime, on: n.notifyStart && !t.milestone },
      { kind: "end", date: t.end, time: t.endTime, on: n.notifyEnd },
    ];
    for (const e of ends) {
      if (!e.on || !e.date || !e.time) continue;
      const instant = toInstant(e.date, e.time, s.tz);
      for (const lead of LEADS) {
        if (!n.leads.includes(lead.id)) continue;
        const trigger = instant - lead.minutes * 60000;
        if (trigger <= fromMs || trigger > toMs) continue;
        // dedupe across restarts
        const key = `${t.path}|${e.kind}|${lead.id}|${instant}`;
        if (n.sent[key]) continue;
        n.sent[key] = Date.now();
        dirty = true;
        const at = `${formatDate(e.date, s.dateFormat)} ${e.time}`;
        await sendWebhooks(n.discordWebhook, n.slackWebhook, tr().notifyLine(t.name, e.kind, at, leadLabel(lead.id)));
      }
    }
  }
  // prune sent keys older than 14 days
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [k, ts] of Object.entries(n.sent)) {
    if (ts < cutoff) {
      delete n.sent[k];
      dirty = true;
    }
  }
  if (dirty) await plugin.saveData(plugin.settings);
}

// "send a test message" from settings; result shown as a Notice
export async function sendTestNotification(plugin: GanttPlugin): Promise<void> {
  const n = plugin.settings.notify;
  if (!n.discordWebhook && !n.slackWebhook) {
    new Notice(tr().setWebhookDesc); // no webhook configured
    return;
  }
  const ok = await sendWebhooks(n.discordWebhook, n.slackWebhook, tr().notifyTestMsg);
  new Notice(ok ? "✅" : "⚠️ (console)");
}

// post to the configured webhooks; one failure must not block the other target or the loop
async function sendWebhooks(discord: string, slack: string, msg: string): Promise<boolean> {
  let ok = true;
  if (discord) {
    try {
      await requestUrl({ url: discord, method: "POST", contentType: "application/json", body: JSON.stringify({ content: msg }) });
    } catch (e) {
      ok = false;
      console.error("Task Gantt: Discord notification failed", e);
    }
  }
  if (slack) {
    try {
      await requestUrl({ url: slack, method: "POST", contentType: "application/json", body: JSON.stringify({ text: msg }) });
    } catch (e) {
      ok = false;
      console.error("Task Gantt: Slack notification failed", e);
    }
  }
  return ok;
}
