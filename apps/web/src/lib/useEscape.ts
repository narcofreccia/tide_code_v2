import { useEffect, useRef } from "react";

/**
 * One Esc for every overlay (dialogs, Settings, the Experts board). Overlays register on a
 * stack and only the topmost handles the key, so one Esc closes one layer. Inside a text
 * field the first Esc only leaves the field (blur); the next Esc closes. A handler that
 * already took the key (`preventDefault`, e.g. an open listbox or an inline rename) wins, and
 * so does a popover or menu opened over the layer (they close themselves on Esc).
 */
interface Layer {
  run: React.RefObject<() => void>;
  blurFirst: React.RefObject<boolean>;
  root: React.RefObject<HTMLElement | null> | undefined;
}

/** Portalled floating panels (`ui/Popover`, `ui/Menu`) that handle their own Esc. */
const FLOATING = '[data-tide-layer], [role="menu"]';

/** A floating panel that does not hold the layer was opened over it: that panel's Esc comes first. */
function floatingAbove(layer: Layer): boolean {
  const root = layer.root?.current ?? null;
  return Array.from(document.querySelectorAll(FLOATING)).some((panel) => root === null || !panel.contains(root));
}

const layers: Layer[] = [];

const TEXTLESS_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"]);

/** Typing targets: text-like inputs, textareas, selects and contenteditable regions. */
export function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !TEXTLESS_INPUTS.has(target.type);
  return target.isContentEditable || target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const top = layers[layers.length - 1];
  if (!top || floatingAbove(top)) return;
  event.preventDefault();
  // neither window-level Esc handlers (rail selection, stop turn) nor a popover that holds
  // this layer may also act on it
  event.stopImmediatePropagation();
  if (top.blurFirst.current && isEditableTarget(event.target)) {
    event.target.blur();
    return;
  }
  top.run.current();
}

/**
 * Registers an Esc layer while `enabled`. Later registrations sit on top, except that a layer
 * never sits above one rendered inside it. The handler is read
 * through a ref, so a new callback each render keeps the layer's place in the stack.
 * `blurFirst: false` closes even from a text field (the ⌘K palette, whose field is the dialog).
 * `root` is the layer's element, so a popover opened from inside it is not mistaken for one above.
 */
export function useEscape(
  onEscape: () => void,
  { enabled = true, blurFirst = true, root }: { enabled?: boolean; blurFirst?: boolean; root?: React.RefObject<HTMLElement | null> } = {},
): void {
  const run = useRef(onEscape);
  const blur = useRef(blurFirst);
  run.current = onEscape;
  blur.current = blurFirst;
  useEffect(() => {
    if (!enabled) return undefined;
    const layer: Layer = { run, blurFirst: blur, root };
    // children register first when mounted together: an overlay holding another sits below it
    const el = root?.current ?? null;
    const held = el === null ? -1 : layers.findIndex((other) => other.root?.current != null && el.contains(other.root.current));
    layers.splice(held === -1 ? layers.length : held, 0, layer);
    if (layers.length === 1) document.addEventListener("keydown", onKeyDown);
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      if (layers.length === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, root]);
}
