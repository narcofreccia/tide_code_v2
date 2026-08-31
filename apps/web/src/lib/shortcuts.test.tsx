import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SHORTCUTS, handleShortcut } from "./shortcuts.ts";
import { KeyboardSection } from "../components/settings/KeyboardSection.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
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
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.getState().selectThread("t1");
    expect(press("2")).toBe(true);
    expect(useUi.getState().focusMode).toBe("split");
    expect(press("3")).toBe(true);
    expect(useUi.getState().focusMode).toBe("workbench");
    expect(press(",")).toBe(true);
    expect(useUi.getState().view).toBe("settings");
    // ⌘S is table-only (Monaco owns it) and ⌘⇧B is not bound at all
    expect(press("s")).toBe(false);
    expect(press("b", { shiftKey: true })).toBe(false);
    // ⌘` needs the workbench on screen, which "workbench" focus satisfies
    expect(press("`")).toBe(true);
  });

  it("does not swallow a key whose entry is out of context", () => {
    // nothing selected: every thread/workbench-scoped binding declines
    expect(press("1")).toBe(false);
    expect(press("`")).toBe(false);
    expect(press("p", { shiftKey: false })).toBe(false);
    expect(press("d", { shiftKey: true })).toBe(false);
    // always-scoped ones still run
    expect(press("0")).toBe(true);

    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.getState().selectThread("t1");
    useUi.getState().setFocusMode("thread");
    // a thread is selected but the workbench is hidden
    expect(press("1")).toBe(true);
    expect(press("`")).toBe(false);
    useUi.getState().setFocusMode("split");
    expect(press("`")).toBe(true);
  });

  it("ignores keys without the ⌘/^ modifier", () => {
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "0" }))).toBe(false);
  });

  it("⌘⇧X opens a new experts session for the current project", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1", { projectId: "p1" }) },
      }),
    );
    useUi.getState().selectThread("t1");
    expect(press("x", { shiftKey: true })).toBe(true);
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
  });
});
