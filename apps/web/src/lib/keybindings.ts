/**
 * Rebindable shortcuts: a binding is a string `mod+shift+alt+<key>` (parts in that
 * order, `mod` = ⌘ on macOS / Ctrl elsewhere; either of Meta/Ctrl counts). The same
 * form is what `UserSettings.keybindings` stores on the server.
 */

export type BindingScope = "always" | "thread" | "workbench" | "experts";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "OS", "Hyper", "Super"]);

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
}

/** `KeyN` / `Digit1` → `n` / `1`: with ⌥ held the produced character is unusable (⌥N = ˜). */
function keyFromCode(code: string): string | undefined {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return undefined;
}

/** The binding a key event represents, or `null` while only modifiers are down. */
export function normalizeEvent(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  let key = event.key === " " ? "space" : event.key.toLowerCase();
  if (event.altKey) key = keyFromCode(event.code) ?? key;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(key);
  return parts.join("+");
}

export function parseBinding(binding: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = binding.split("+");
  // a literal "+" key serialises as "mod++"
  const key = binding.endsWith("++") ? "+" : (parts[parts.length - 1] ?? "");
  const mods = new Set(parts.slice(0, -1));
  return { mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt"), key };
}

const KEY_LABEL: Record<string, string> = {
  enter: "↵", escape: "Esc", space: "Space", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  backspace: "⌫", tab: "Tab",
};

/** `⌘⇧E` on macOS, `Ctrl+Shift+E` elsewhere. */
export function formatBinding(binding: string, mac: boolean = isMac()): string {
  const { mod, shift, alt, key } = parseBinding(binding);
  const label = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1));
  if (mac) return `${mod ? "⌘" : ""}${shift ? "⇧" : ""}${alt ? "⌥" : ""}${label}`;
  return [mod ? "Ctrl" : "", shift ? "Shift" : "", alt ? "Alt" : "", label].filter(Boolean).join("+");
}

/** Whether two scopes can be live at the same time (workbench ⊂ thread; the Experts board is its own view). */
export function scopesOverlap(a: BindingScope = "always", b: BindingScope = "always"): boolean {
  if (a === "always" || b === "always") return true;
  if (a === "experts" || b === "experts") return a === b;
  return true;
}

export interface BindingEntry {
  id: string;
  label: string;
  when?: BindingScope;
  binding: string;
  /** true while on the shipped default: two defaults sharing a chord are deliberate (⌘⇧E) */
  isDefault: boolean;
}

/** Other entries that would fight `entry` for the same chord in an overlapping scope. */
export function findConflicts(entry: BindingEntry, all: BindingEntry[]): BindingEntry[] {
  return all.filter(
    (other) =>
      other.id !== entry.id &&
      other.binding === entry.binding &&
      scopesOverlap(entry.when, other.when) &&
      !(entry.isDefault && other.isDefault),
  );
}
