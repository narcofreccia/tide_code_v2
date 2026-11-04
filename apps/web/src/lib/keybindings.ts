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

/** A two-key sequence like `g m`: space-separated bare keys, no modifiers. */
export function isChord(binding: string): boolean {
  return /^\S+ \S+$/.test(binding);
}

export function parseChord(binding: string): string[] {
  return binding.split(" ").filter(Boolean);
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

/** `⌘⇧R` on macOS, `Ctrl+Shift+R` elsewhere. */
export function formatBinding(binding: string, mac: boolean = isMac()): string {
  if (isChord(binding)) {
    return parseChord(binding).map((key) => formatBinding(key, mac)).join(" then ");
  }
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
  /** true while on the shipped default */
  isDefault: boolean;
}

/** Same keystroke, or a bare key that is the first key of a chord (`g` swallows `g m`). */
function bindingsClash(a: string, b: string): boolean {
  if (a === b) return true;
  if (isChord(a) && !isChord(b)) return parseChord(a)[0] === b;
  if (isChord(b) && !isChord(a)) return parseChord(b)[0] === a;
  return false;
}

/** Other entries that would fight `entry` for the same chord in an overlapping scope. */
export function findConflicts(entry: BindingEntry, all: BindingEntry[]): BindingEntry[] {
  return all.filter(
    (other) =>
      other.id !== entry.id &&
      bindingsClash(other.binding, entry.binding) &&
      scopesOverlap(entry.when, other.when) &&
      !(entry.isDefault && other.isDefault),
  );
}

/**
 * Single-key rail bindings (R12): live only while focus is outside a text field.
 * Stored like the chorded ones (`UserSettings.keybindings[id]`), so a user can move
 * `j`/`k` without touching the rest of the map.
 */
export interface RailBinding {
  id: RailBindingId;
  label: string;
  binding: string;
}

export type RailBindingId =
  | "rail.search"
  | "rail.next"
  | "rail.prev"
  | "rail.open"
  | "rail.settle"
  | "rail.snooze"
  | "rail.merge"
  | "rail.select";

export const RAIL_BINDINGS: RailBinding[] = [
  { id: "rail.search", label: "Search threads", binding: "/" },
  { id: "rail.next", label: "Rail: next thread", binding: "j" },
  { id: "rail.prev", label: "Rail: previous thread", binding: "k" },
  { id: "rail.open", label: "Rail: open focused thread", binding: "enter" },
  { id: "rail.settle", label: "Rail: settle / unsettle", binding: "e" },
  { id: "rail.snooze", label: "Rail: snooze…", binding: "s" },
  { id: "rail.merge", label: "Rail: merge back", binding: "m" },
  { id: "rail.select", label: "Rail: toggle selection", binding: "x" },
];

/** The rail action a key event triggers, honouring the user's overrides; undefined when none. */
export function matchRailBinding(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  overrides: Record<string, string> = {},
): RailBindingId | undefined {
  const chord = normalizeEvent(event);
  if (chord === null) return undefined;
  return RAIL_BINDINGS.find((entry) => (overrides[entry.id] || entry.binding) === chord)?.id;
}
