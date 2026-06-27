// A single anchored-popover factory shared by the column menu, time dropdown, and date picker.
// It clears any stale popover of the same kind, builds the content, wires outside-click +
// Escape dismissal, and positions the element clamped to the viewport.

export interface PopoverHandle {
  el: HTMLElement;
  close: () => void;
}

export interface PopoverOpts {
  cls: string; // popover class; also used to drop any open popover of this kind first
  anchor: HTMLElement; // element to position under (and to ignore for outside-click)
  flip?: boolean; // flip above the anchor when it would overflow the viewport bottom
}

export function openPopover(
  opts: PopoverOpts,
  build: (el: HTMLElement, close: () => void) => void
): PopoverHandle {
  const { cls, anchor, flip } = opts;
  activeDocument.querySelectorAll(`.${cls}`).forEach((e) => e.remove());
  const el = activeDocument.body.createDiv({ cls });

  const close = () => {
    el.remove();
    activeDocument.removeEventListener("pointerdown", onOutside, true);
    activeDocument.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (e: PointerEvent) => {
    const tg = e.target as Node;
    if (!el.contains(tg) && !anchor.contains(tg)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  build(el, close);

  // Position below the anchor (flip above if it would overflow the bottom), clamped horizontally.
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 4;
  if (flip && top + el.offsetHeight > window.innerHeight) top = Math.max(4, r.top - el.offsetHeight - 4);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;

  activeDocument.addEventListener("pointerdown", onOutside, true);
  activeDocument.addEventListener("keydown", onKey, true);
  return { el, close };
}
