import { App, Modal } from "obsidian";

// A small confirm dialog shown before a destructive action (e.g. delete).
export interface ConfirmOpts {
  title: string;
  body: string;
  sub?: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmOpts) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    if (this.opts.sub) this.contentEl.createEl("p", { cls: "ogantt-confirm-sub", text: this.opts.sub });
    const btns = this.contentEl.createDiv({ cls: "ogantt-confirm-btns" });
    const cancel = btns.createEl("button", { text: this.opts.cancelText });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { cls: "mod-warning", text: this.opts.confirmText });
    ok.onclick = () => {
      this.close();
      this.opts.onConfirm();
    };
    window.setTimeout(() => ok.focus(), 0); // focus the confirm button so Enter confirms
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
