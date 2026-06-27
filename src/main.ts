import { Plugin, WorkspaceLeaf, TFolder, TFile, Menu, TAbstractFile } from "obsidian";
import { GanttSettings, DEFAULT_SETTINGS, GanttSettingTab } from "./settings";
import { GanttView } from "./view";
import { VIEW_TYPE_GANTT, GanttViewState } from "./types";
import { t } from "./i18n";
import { checkNotifications } from "./notify";

export default class GanttPlugin extends Plugin {
  settings!: GanttSettings;
  private lastNotifyCheck = 0; // last notification check (epoch ms)

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));

    // ribbon opens the focused folder
    this.addRibbonIcon("gantt-chart", t().ribbonOpen, () => {
      void this.activateView(this.currentFolder());
    });

    this.addCommand({
      id: "open-gantt",
      name: t().commandOpen,
      callback: () => void this.activateView(this.currentFolder()),
    });

    // folder context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle(t().menuOpen)
              .setIcon("gantt-chart")
              .onClick(() => void this.activateView(file.path))
          );
        }
      })
    );

    this.addSettingTab(new GanttSettingTab(this.app, this));

    // notification scheduler: every minute, send triggers that arrived since the last check.
    // triggers missed while Obsidian was closed are skipped (no burst on startup).
    this.app.workspace.onLayoutReady(() => {
      this.lastNotifyCheck = Date.now();
      this.registerInterval(
        window.setInterval(() => {
          const now = Date.now();
          const from = this.lastNotifyCheck;
          this.lastNotifyCheck = now;
          void checkNotifications(this, from, now);
        }, 60_000)
      );
    });
  }

  // best-effort current folder
  private currentFolder(): string {
    // 1. folder selected in the file explorer
    const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = explorer?.view as unknown as { tree?: { focusedItem?: { file?: TAbstractFile } } } | undefined;
    const focused = view?.tree?.focusedItem?.file;
    if (focused instanceof TFolder) return focused.path;
    if (focused instanceof TFile && focused.parent) return focused.parent.path;
    // 2. active note's parent folder
    const af = this.app.workspace.getActiveFile();
    if (af?.parent) return af.parent.path;
    // 3. configured default
    return this.settings.rootFolder ?? "";
  }

  // open the view scoped to a folder
  async activateView(folderPath: string): Promise<void> {
    const state: GanttViewState = { folder: folderPath };
    // reuse an existing view, just re-scope it
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_GANTT,
      active: true,
      state: state as unknown as Record<string, unknown>,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    // loadData() returns any: cast to the saved shape
    const data = (await this.loadData()) as Partial<GanttSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.keys = Object.assign({}, DEFAULT_SETTINGS.keys, this.settings.keys);
    // clone so we don't mutate the shared DEFAULT containers
    this.settings.tagColors = (this.settings.tagColors ?? []).map((c) => ({ ...c }));
    this.settings.folderColors = (this.settings.folderColors ?? []).map((c) => ({ ...c }));
    this.settings.columnWidths = { ...(this.settings.columnWidths ?? {}) };
    // merge notify settings with defaults and clone containers
    this.settings.notify = Object.assign({}, DEFAULT_SETTINGS.notify, this.settings.notify);
    this.settings.notify.leads = [...(this.settings.notify.leads ?? [])];
    this.settings.notify.sent = { ...(this.settings.notify.sent ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT).forEach((leaf: WorkspaceLeaf) => {
      const v = leaf.view;
      if (v instanceof GanttView) void v.refresh();
    });
  }
}
