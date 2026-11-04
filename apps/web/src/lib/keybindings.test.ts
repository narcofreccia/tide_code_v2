import { describe, expect, it } from "vitest";
import { findConflicts, formatBinding, isChord, parseChord, normalizeEvent, parseBinding, scopesOverlap, type BindingEntry } from "./keybindings.ts";

const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe("keybindings", () => {
  it("normalises chords to mod+shift+alt+key", () => {
    expect(normalizeEvent(ev({ key: "E", metaKey: true, shiftKey: true }))).toBe("mod+shift+e");
    expect(normalizeEvent(ev({ key: "k", ctrlKey: true }))).toBe("mod+k");
    expect(normalizeEvent(ev({ key: "˜", code: "KeyN", altKey: true }))).toBe("alt+n");
    expect(normalizeEvent(ev({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(normalizeEvent(ev({ key: " ", metaKey: true }))).toBe("mod+space");
  });

  it("formats for macOS and other platforms", () => {
    expect(formatBinding("mod+shift+e", true)).toBe("⌘⇧E");
    expect(formatBinding("mod+shift+e", false)).toBe("Ctrl+Shift+E");
    expect(formatBinding("alt+n", true)).toBe("⌥N");
    expect(formatBinding("mod+enter", false)).toBe("Ctrl+↵");
    expect(parseBinding("mod+shift+,")).toEqual({ mod: true, shift: true, alt: false, key: "," });
  });

  it("knows which scopes can be live together", () => {
    expect(scopesOverlap("always", "workbench")).toBe(true);
    expect(scopesOverlap("thread", "workbench")).toBe(true);
    expect(scopesOverlap("experts", "thread")).toBe(false);
  });

  it("reports conflicts but not the deliberate default pair", () => {
    const a: BindingEntry = { id: "a", label: "A", when: "thread", binding: "mod+x", isDefault: false };
    const b: BindingEntry = { id: "b", label: "B", when: "workbench", binding: "mod+x", isDefault: true };
    const c: BindingEntry = { id: "c", label: "C", when: "experts", binding: "mod+x", isDefault: false };
    expect(findConflicts(a, [a, b, c]).map((e) => e.id)).toEqual(["b"]);
    const d: BindingEntry = { ...a, id: "d", isDefault: true };
    expect(findConflicts(d, [d, b])).toEqual([]);
  });

  it("parses and formats two-key chords", () => {
    expect(isChord("g m")).toBe(true);
    expect(isChord("mod+k")).toBe(false);
    expect(isChord("j")).toBe(false);
    expect(parseChord("g m")).toEqual(["g", "m"]);
    expect(formatBinding("g m")).toBe("G then M");
  });

  it("flags a bare key equal to a chord's first key", () => {
    const chord: BindingEntry = { id: "goto", label: "Go", binding: "g m", isDefault: true };
    const bare: BindingEntry = { id: "rail", label: "Rail g", binding: "g", isDefault: false };
    const other: BindingEntry = { id: "x", label: "X", binding: "g t", isDefault: false };
    expect(findConflicts(bare, [bare, chord]).map((e) => e.id)).toEqual(["goto"]);
    expect(findConflicts(chord, [bare, chord]).map((e) => e.id)).toEqual(["rail"]);
    expect(findConflicts(other, [other, chord])).toEqual([]);
  });
});
