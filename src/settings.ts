import { App, PluginSettingTab, Setting } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, ZoomMode, DateFormat } from "./types";
import { t as tr } from "./i18n";
import { LEADS, leadLabel, sendTestNotification } from "./notify";

// timezone list (real offsets only, with representative cities)
const TZ_CITIES: [string, string][] = [
  ["-12:00", "Baker Island"],
  ["-11:00", "Midway, Niue"],
  ["-10:00", "Honolulu (Hawaii)"],
  ["-09:30", "Marquesas Islands"],
  ["-09:00", "Anchorage (Alaska)"],
  ["-08:00", "Los Angeles, Vancouver"],
  ["-07:00", "Denver, Phoenix"],
  ["-06:00", "Chicago, Mexico City"],
  ["-05:00", "New York, Toronto, Lima"],
  ["-04:00", "Halifax, Santiago, La Paz"],
  ["-03:30", "St. John's (Newfoundland)"],
  ["-03:00", "São Paulo, Buenos Aires"],
  ["-02:00", "South Georgia"],
  ["-01:00", "Azores, Cape Verde"],
  ["+00:00", "London, Lisbon, UTC"],
  ["+01:00", "Paris, Berlin, Rome, Madrid"],
  ["+02:00", "Cairo, Athens, Kyiv"],
  ["+03:00", "Moscow, Istanbul, Riyadh"],
  ["+03:30", "Tehran"],
  ["+04:00", "Dubai, Baku, Tbilisi"],
  ["+04:30", "Kabul"],
  ["+05:00", "Karachi, Tashkent"],
  ["+05:30", "New Delhi, Mumbai, Colombo"],
  ["+05:45", "Kathmandu"],
  ["+06:00", "Dhaka, Almaty"],
  ["+06:30", "Yangon"],
  ["+07:00", "Bangkok, Jakarta, Hanoi"],
  ["+08:00", "Beijing, Singapore, Hong Kong, Taipei"],
  ["+08:45", "Eucla"],
  ["+09:00", "Tokyo, Osaka, Seoul"],
  ["+09:30", "Adelaide, Darwin"],
  ["+10:00", "Sydney, Melbourne, Guam"],
  ["+10:30", "Lord Howe Island"],
  ["+11:00", "Nouméa, Solomon Islands"],
  ["+12:00", "Auckland, Fiji"],
  ["+12:45", "Chatham Islands"],
  ["+13:00", "Apia (Samoa), Nuku'alofa (Tonga)"],
  ["+14:00", "Kiritimati"],
];

// Plugin settings
export interface GanttSettings {
  rootFolder: string; // parent folder to aggregate
  recurse: boolean; // recurse into subfolders
  statuses: StatusDef[];
  defaultZoom: ZoomMode;
  dateFormat: DateFormat; // display-only date format
  // timezone for displaying/saving times: "system" (device) or a fixed GMT offset like "+09:00"
  tz: string;
  detailWidth: number; // detail panel width (px)
  visibleColumns: string[]; // optional columns shown (name is always shown)
  columnWidths: Record<string, number>; // per-column width overrides (px); unset = default
  sortBy: string; // sort column id
  sortDir: "asc" | "desc"; // sort direction
  // manual color overrides (unset → auto from name hash)
  tagColors: { name: string; color: string }[];
  folderColors: { name: string; color: string }[];
  // notifications via incoming webhooks
  notify: {
    discordWebhook: string; // empty disables
    slackWebhook: string;
    notifyStart: boolean; // notify for start
    notifyEnd: boolean; // notify for due
    leads: string[]; // enabled lead ids
    sent: Record<string, number>; // sent keys → timestamp (dedupe)
  };
  sidebarLeafId?: string; // persisted right-sidebar leaf id (reused across reloads)
  // frontmatter key names
  keys: {
    start: string;
    end: string;
    status: string;
    assignee: string;
    after: string;
    progress: string;
    milestone: string;
    parent: string;
  };
}

export const DEFAULT_SETTINGS: GanttSettings = {
  rootFolder: "",
  recurse: true,
  statuses: [
    // muted modern palette (slate / indigo / rose / emerald)
    { id: "todo", label: "To do", color: "#94a3b8" },
    { id: "in-progress", label: "In progress", color: "#6366f1" },
    { id: "blocked", label: "Blocked", color: "#f43f5e" },
    { id: "done", label: "Done", color: "#10b981" },
  ],
  defaultZoom: "Week",
  dateFormat: "YYYY/MM/DD",
  tz: "system",
  detailWidth: 380,
  visibleColumns: ["start", "end"],
  columnWidths: {},
  sortBy: "start",
  sortDir: "asc",
  tagColors: [],
  folderColors: [],
  notify: {
    discordWebhook: "",
    slackWebhook: "",
    notifyStart: true,
    notifyEnd: true,
    leads: ["1d", "1h", "10m"],
    sent: {},
  },
  keys: {
    start: "start",
    end: "end",
    status: "status",
    assignee: "assignee",
    after: "after",
    progress: "progress",
    milestone: "milestone",
    parent: "parent",
  },
};

export class GanttSettingTab extends PluginSettingTab {
  plugin: GanttPlugin;

  constructor(app: App, plugin: GanttPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private save(): void {
    void this.plugin.saveSettings();
  }

  // ===== control builders shared by getSettingDefinitions and the display() fallback =====
  private ctlRootFolder(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addText((t) =>
      t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(s.rootFolder).onChange((v) => {
        s.rootFolder = v.trim();
        this.save();
      })
    );
  }

  private ctlRecurse(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addToggle((t) => t.setValue(s.recurse).onChange((v) => { s.recurse = v; this.save(); }));
  }

  private ctlZoom(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((d) =>
      d.addOptions({ Day: "Day", Week: "Week", Month: "Month", Fit: "Fit" }).setValue(s.defaultZoom).onChange((v) => {
        s.defaultZoom = v as ZoomMode;
        this.save();
      })
    );
  }

  private ctlDateFormat(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((d) =>
      d
        .addOptions({ "YYYY/MM/DD": "YYYY/MM/DD", "DD/MM/YYYY": "DD/MM/YYYY", "MM/DD/YYYY": "MM/DD/YYYY" })
        .setValue(s.dateFormat)
        .onChange((v) => { s.dateFormat = v as DateFormat; this.save(); })
    );
  }

  private ctlTimezone(setting: Setting): void {
    const s = this.plugin.settings;
    const opts: Record<string, string> = { system: tr().setTimezoneSystem };
    // list offsets with representative cities
    for (const [v, cities] of TZ_CITIES) opts[v] = `GMT${v} — ${cities}`;
    // keep a saved offset selectable even if it left the list
    if (s.tz !== "system" && !opts[s.tz]) opts[s.tz] = `GMT${s.tz}`;
    setting.addDropdown((d) => d.addOptions(opts).setValue(s.tz).onChange((v) => { s.tz = v; this.save(); }));
  }

  private ctlStatusRow(setting: Setting, st: StatusDef): void {
    setting
      .addText((t) => t.setPlaceholder(tr().setStatusId).setValue(st.id).onChange((v) => { st.id = v.trim(); this.save(); }))
      .addText((t) => t.setPlaceholder(tr().setStatusLabel).setValue(st.label).onChange((v) => { st.label = v; this.save(); }))
      .addColorPicker((c) => c.setValue(st.color).onChange((v) => { st.color = v; this.save(); }));
  }

  private ctlTagColorRow(setting: Setting, tc: { name: string; color: string }): void {
    setting
      .addText((t) => t.setPlaceholder(tr().setColorName).setValue(tc.name).onChange((v) => { tc.name = v.trim(); this.save(); }))
      .addColorPicker((c) => c.setValue(tc.color).onChange((v) => { tc.color = v; this.save(); }));
  }

  private ctlKeyRow(setting: Setting, k: keyof GanttSettings["keys"]): void {
    const s = this.plugin.settings;
    setting.addText((t) => t.setValue(s.keys[k]).onChange((v) => { s.keys[k] = v.trim() || k; this.save(); }));
  }

  private ctlWebhook(setting: Setting, key: "discordWebhook" | "slackWebhook", placeholder: string): void {
    const n = this.plugin.settings.notify;
    setting.addText((t) => t.setPlaceholder(placeholder).setValue(n[key]).onChange((v) => { n[key] = v.trim(); this.save(); }));
  }

  private ctlNotifyToggle(setting: Setting, key: "notifyStart" | "notifyEnd"): void {
    const n = this.plugin.settings.notify;
    setting.addToggle((t) => t.setValue(n[key]).onChange((v) => { n[key] = v; this.save(); }));
  }

  private ctlLeadToggle(setting: Setting, id: string): void {
    const n = this.plugin.settings.notify;
    setting.addToggle((t) =>
      t.setValue(n.leads.includes(id)).onChange((v) => {
        n.leads = v ? [...new Set([...n.leads, id])] : n.leads.filter((x) => x !== id);
        this.save();
      })
    );
  }

  // ===== display() (@deprecated 1.13.0, but keeping it is the only viable option) =====
  // Its successor getSettingDefinitions/update is @since 1.13.0 and incompatible with minAppVersion 1.7.2
  // (using it trips no-unsupported-api; raising minAppVersion to 1.13.0 locks out 1.12.x users).
  // To avoid invoking the deprecated API, redraws go via this.draw(); we never call this.display() ourselves.
  display(): void {
    this.draw();
  }

  private draw(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    this.ctlRootFolder(new Setting(containerEl).setName(tr().setDefaultFolderName).setDesc(tr().setDefaultFolderDesc));
    this.ctlRecurse(new Setting(containerEl).setName(tr().setRecurseName).setDesc(tr().setRecurseDesc));
    this.ctlZoom(new Setting(containerEl).setName(tr().setDefaultZoomName));
    this.ctlDateFormat(new Setting(containerEl).setName(tr().setDateFormatName));
    this.ctlTimezone(new Setting(containerEl).setName(tr().setTimezoneName).setDesc(tr().setTimezoneDesc));

    // status list (id/label/color + delete, add button at the end)
    new Setting(containerEl).setName(tr().setStatusesHeading).setHeading();
    s.statuses.forEach((st, i) => {
      const row = new Setting(containerEl).setClass("ogantt-setting-row");
      this.ctlStatusRow(row, st);
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
          s.statuses.splice(i, 1);
          this.save();
          this.draw();
        })
      );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddStatus).setCta().onClick(() => {
        s.statuses.push({ id: "new", label: "New", color: "#888888" });
        this.save();
        this.draw();
      })
    );

    // tag colors (name + color + delete; folder colors via right-click in the table)
    new Setting(containerEl).setName(tr().setTagColorsHeading).setHeading();
    s.tagColors.forEach((tc, i) => {
      const row = new Setting(containerEl).setClass("ogantt-setting-row");
      this.ctlTagColorRow(row, tc);
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
          s.tagColors.splice(i, 1);
          this.save();
          this.draw();
        })
      );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddTagColor).onClick(() => {
        s.tagColors.push({ name: "", color: "#888888" });
        this.save();
        this.draw();
      })
    );

    // notifications (webhooks + lead times)
    new Setting(containerEl).setName(tr().setNotifyHeading).setDesc(tr().setNotifyDesc).setHeading();
    this.ctlWebhook(
      new Setting(containerEl).setName("Discord webhook URL").setDesc(tr().setWebhookDesc),
      "discordWebhook",
      "https://discord.com/api/webhooks/…"
    );
    this.ctlWebhook(
      new Setting(containerEl).setName("Slack webhook URL").setDesc(tr().setWebhookDesc),
      "slackWebhook",
      "https://hooks.slack.com/services/…"
    );
    // send-a-test button for instant webhook verification
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setNotifyTestName).onClick(() => void sendTestNotification(this.plugin))
    );
    this.ctlNotifyToggle(new Setting(containerEl).setName(tr().setNotifyStartName), "notifyStart");
    this.ctlNotifyToggle(new Setting(containerEl).setName(tr().setNotifyEndName), "notifyEnd");
    new Setting(containerEl).setName(tr().setLeadsName).setHeading();
    for (const lead of LEADS) {
      this.ctlLeadToggle(new Setting(containerEl).setName(leadLabel(lead.id)), lead.id);
    }

    // frontmatter key names
    new Setting(containerEl).setName(tr().setKeysHeading).setHeading();
    (Object.keys(s.keys) as (keyof GanttSettings["keys"])[]).forEach((k) => {
      this.ctlKeyRow(new Setting(containerEl).setName(k), k);
    });
  }
}
