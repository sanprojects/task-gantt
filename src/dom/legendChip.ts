// Render a legend chip: a colored swatch + label, optionally toggleable like a checkbox.
export function legendChip(
  parent: HTMLElement,
  color: string,
  label: string,
  onToggle?: () => void,
  on = true
): void {
  const chip = parent.createDiv({ cls: "ogantt-legend-chip" });
  const sw = chip.createSpan({ cls: "ogantt-legend-swatch" });
  sw.style.background = color;
  chip.createSpan({ text: label });
  if (onToggle) {
    chip.classList.add("is-toggle");
    chip.classList.toggle("is-off", !on);
    chip.setAttr("role", "checkbox");
    chip.setAttr("aria-checked", String(on));
    chip.setAttr("tabindex", "0");
    chip.onclick = onToggle;
    chip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } };
  }
}
