import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, ZoomMode, DateFormat } from "./types";
import { t as tr } from "./i18n";

// プラグイン設定 / Plugin settings
export interface GanttSettings {
  rootFolder: string; // 集計する親フォルダ / parent folder to aggregate
  recurse: boolean; // サブフォルダを再帰的に辿るか / recurse into subfolders
  statuses: StatusDef[];
  defaultZoom: ZoomMode;
  dateFormat: DateFormat; // 表示用の日付フォーマット / display-only date format
  detailWidth: number; // 詳細パネルの幅(px) / detail panel width (px)
  visibleColumns: string[]; // 表示する任意列（name は常時表示）/ optional columns shown (name is always shown)
  sortBy: string; // ソート列 id（name/start/end/assignee/status）/ sort column id
  sortDir: "asc" | "desc"; // ソート方向 / sort direction
  // タグ/フォルダの色（手動上書き。未登録は名前ハッシュで自動生成）/ manual color overrides (unset → auto from name hash)
  tagColors: { name: string; color: string }[];
  folderColors: { name: string; color: string }[];
  // フロントマターのキー名（プロジェクトに合わせて変更可）/ frontmatter key names
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
    { id: "todo", label: "To do", color: "#9aa0a6" },
    { id: "in-progress", label: "In progress", color: "#3b82f6" },
    { id: "blocked", label: "Blocked", color: "#ef4444" },
    { id: "done", label: "Done", color: "#22c55e" },
  ],
  defaultZoom: "Week",
  dateFormat: "YYYY/MM/DD",
  detailWidth: 380,
  visibleColumns: ["start", "end"],
  sortBy: "start",
  sortDir: "asc",
  tagColors: [],
  folderColors: [],
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

  // ===== 各入力欄の組み立て（推奨の getSettingDefinitions と display() フォールバックで共有）=====
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

  // ===== 推奨: 宣言的設定（@since 1.13.0）。実機 1.13.0+ のランタイムで使用される =====
  // ===== Preferred: declarative settings (@since 1.13.0); used on 1.13.0+ runtimes =====
  // 動的リスト(statuses/tagColors)は type:"list" の add/delete アフォーダンス＋update() で再構築。
  // dynamic lists use the type:"list" add/delete affordances and rebuild via update().
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      { name: tr().setDefaultFolderName, desc: tr().setDefaultFolderDesc, render: (setting: Setting) => this.ctlRootFolder(setting) },
      { name: tr().setRecurseName, desc: tr().setRecurseDesc, render: (setting: Setting) => this.ctlRecurse(setting) },
      { name: tr().setDefaultZoomName, render: (setting: Setting) => this.ctlZoom(setting) },
      { name: tr().setDateFormatName, render: (setting: Setting) => this.ctlDateFormat(setting) },
      {
        type: "list",
        heading: tr().setStatusesHeading,
        onDelete: (i: number) => { s.statuses.splice(i, 1); this.save(); this.update(); },
        addItem: {
          name: tr().setAddStatus,
          action: () => { s.statuses.push({ id: "new", label: "New", color: "#888888" }); this.save(); this.update(); },
        },
        items: s.statuses.map((st) => ({
          name: st.label || st.id,
          render: (setting: Setting) => this.ctlStatusRow(setting, st),
        })),
      },
      {
        type: "list",
        heading: tr().setTagColorsHeading,
        emptyState: tr().setNoColorsYet,
        onDelete: (i: number) => { s.tagColors.splice(i, 1); this.save(); this.update(); },
        addItem: {
          name: tr().setAddTagColor,
          action: () => { s.tagColors.push({ name: "", color: "#888888" }); this.save(); this.update(); },
        },
        items: s.tagColors.map((tc) => ({
          name: tc.name || tr().setColorName,
          render: (setting: Setting) => this.ctlTagColorRow(setting, tc),
        })),
      },
      {
        type: "group",
        heading: tr().setKeysHeading,
        items: (Object.keys(s.keys) as (keyof GanttSettings["keys"])[]).map((k) => ({
          name: k,
          render: (setting: Setting) => this.ctlKeyRow(setting, k),
        })),
      },
    ];
  }

  // ===== フォールバック: display()（@deprecated 1.13.0）。getSettingDefinitions 非対応の旧ランタイム(例: 1.12.x)で使われる。 =====
  // 非推奨 API の「呼び出し」を避けるため、再描画は this.draw() に委譲し this.display() は内部から呼ばない。
  // ===== Fallback: display() (@deprecated 1.13.0) for runtimes that lack getSettingDefinitions (e.g. 1.12.x). =====
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

    // ステータス一覧（id/ラベル/色＋削除、末尾に追加ボタン）/ status list (id/label/color + delete, add button at the end)
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

    // タグの色（名前＋色＋削除。フォルダの色は表で右クリック）/ tag colors (name + color + delete; folder colors via right-click in the table)
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

    // フロントマターのキー名 / frontmatter key names
    new Setting(containerEl).setName(tr().setKeysHeading).setHeading();
    (Object.keys(s.keys) as (keyof GanttSettings["keys"])[]).forEach((k) => {
      this.ctlKeyRow(new Setting(containerEl).setName(k), k);
    });
  }
}
