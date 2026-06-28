import { GanttSettings } from "./settings";

// HSL → #rrggbb (color inputs need a hex value).
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Deterministic color from any name (assignee/tag/folder): the same name always maps to the same color.
export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return hslToHex(h, 55, 55);
}

// Tag/folder color: a manual override if present, otherwise auto from the name hash.
export function tagColor(settings: GanttSettings, tag: string): string {
  return settings.tagColors.find((c) => c.name === tag)?.color || hashColor(tag);
}
export function folderColor(settings: GanttSettings, name: string): string {
  return settings.folderColors.find((c) => c.name === name)?.color || hashColor(name);
}

// Paint a tag chip (border + faint background + text); used by the table tags column.
export function paintTagChip(settings: GanttSettings, chip: HTMLElement, tag: string): void {
  const c = tagColor(settings, tag);
  chip.style.borderColor = c;
  chip.style.color = c;
  chip.style.background = `color-mix(in srgb, ${c} 14%, transparent)`;
}
