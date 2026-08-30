import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SHORTCUTS, handleShortcut } from "./shortcuts.ts";
import { KeyboardSection } from "../components/settings/KeyboardSection.tsx";
import { resetUi } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function press(key: string, init: KeyboardEventInit = {}): boolean {
  return handleShortcut(new KeyboardEvent("keydown", { key, metaKey: true, ...init }));
}

describe("shortcuts registry", () => {
  it("is the single list behind the Keyboard table and the key map", () => {
    render(<KeyboardSection />);
    const rows = [...screen.getByRole("table").querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-shortcut")).sort()).toEqual(
      SHORTCUTS.map((s) => s.id).sort(),
    );
    for (const shortcut of SHORTCUTS) {
      const row = rows.find((r) => r.getAttribute("data-shortcut") === shortcut.id);
      expect(row?.textContent).toContain(shortcut.keys);
      expect(row?.textContent).toContain(shortcut.label);
    }
  });

  it("dispatches only the entries that carry an action", () => {
    expect(press("2")).toBe(true);
    expect(useUi.getState().focusMode).toBe("split");
    expect(press("3")).toBe(true);
    expect(useUi.getState().focusMode).toBe("workbench");
    expect(press(",")).toBe(true);
    expect(useUi.getState().view).toBe("settings");
    // ⌘S is table-only (Monaco owns it) and ⌘⇧B is not bound at all
    expect(press("s")).toBe(false);
    expect(press("b", { shiftKey: true })).toBe(false);
    // thread-scoped bindings do nothing without a selected thread
    expect(press("`")).toBe(false);
  });

  it("ignores keys without the ⌘/^ modifier", () => {
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "0" }))).toBe(false);
  });
});
