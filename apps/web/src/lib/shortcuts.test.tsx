import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SHORTCUTS, handleShortcut, shortcutKeys } from "./shortcuts.ts";
import { KeyboardSection } from "../components/settings/KeyboardSection.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  delete (window as unknown as Record<string, unknown>)["__TAURI__"];
});

/** Pretend to run inside the Tauri shell, where ⌘N / ⌘W are bindable. */
function asDesktop(): void {
  (window as unknown as Record<string, unknown>)["__TAURI__"] = {};
}

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
      expect(row?.textContent).toContain(shortcutKeys(shortcut).replace(" then ", ""));
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

  it("⌘N opens the new-thread form for the project in scope", () => {
    asDesktop();
    // no project at all: the key is left to the browser/shell
    expect(press("n")).toBe(false);

    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1") },
      }),
    );
    expect(press("n")).toBe(true);
    expect(useUi.getState().newThreadProjectId).toBe("p1");
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
    // a thread is selected but the workbench is hidden: ⌘` widens to Split and opens the drawer (R12)
    expect(press("1")).toBe(true);
    expect(press("`")).toBe(true);
    expect(useUi.getState().focusMode).toBe("split");
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

  it("binds ⌥N / ⌥W instead of ⌘N / ⌘W outside the desktop shell", () => {
    const model = modelWith({
      projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
      threads: { t1: makeThread("t1") },
    });
    attachFakeStore(model);
    const keys = (id: string): string => shortcutKeys(SHORTCUTS.find((s) => s.id === id)!);
    expect(keys("new-thread")).toBe("⌥N");
    expect(keys("close-tab")).toBe("⌥W");
    // the browser owns ⌘N
    expect(press("n")).toBe(false);
    // ⌥N is a dead key on macOS, so it binds by physical key
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "ñ", code: "KeyN", altKey: true }))).toBe(true);
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    asDesktop();
    expect(keys("new-thread")).toBe("⌘N");
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "ñ", code: "KeyN", altKey: true }))).toBe(false);
  });
});

describe("custom keybindings", () => {
  it("honours a rebound chord and drops the old default", async () => {
    const { useServerSettings } = await import("../state/serverSettings.ts");
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.getState().selectThread("t1");
    useServerSettings.setState({ settings: { ...useServerSettings.getState().settings, keybindings: { "focus-split": "mod+shift+9" } } });
    expect(press("9", { shiftKey: true })).toBe(true);
    expect(useUi.getState().focusMode).toBe("split");
    useUi.getState().setFocusMode("thread");
    expect(press("2")).toBe(false);
    expect(useUi.getState().focusMode).toBe("thread");
    useServerSettings.setState({ settings: { ...useServerSettings.getState().settings, keybindings: {} } });
  });

  it("R12: ⌘⇧E is the file tree alone; effort moved to ⌘⇧R", async () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.getState().selectThread("t1");
    useUi.getState().setFocusMode("workbench");
    expect(press("e", { shiftKey: true })).toBe(true);
    expect(SHORTCUTS.filter((s) => s.keys === "⌘⇧E").map((s) => s.id)).toEqual(["tree"]);
    expect(SHORTCUTS.find((s) => s.id === "effort")?.keys).toBe("⌘⇧R");
  });
});

describe("rail keys in the registry", () => {
  it("lists every RAIL_BINDINGS id under Rail with its bare default", async () => {
    const { RAIL_BINDINGS } = await import("./keybindings.ts");
    const { bindingEntries, defaultBinding } = await import("./shortcuts.ts");
    const rail = SHORTCUTS.filter((s) => s.group === "Rail");
    expect(rail.map((s) => s.id)).toEqual(RAIL_BINDINGS.map((b) => b.id));
    expect(rail.map((s) => s.keys)).toEqual(["/", "j", "k", "↵", "e", "s", "m", "x"]);
    for (const shortcut of rail) expect(defaultBinding(shortcut)).toBe(RAIL_BINDINGS.find((b) => b.id === shortcut.id)?.binding);
    const entries = bindingEntries({ "rail.next": "mod+j" });
    expect(entries.find((e) => e.id === "rail.next")).toMatchObject({ binding: "mod+j", isDefault: false });
    expect(entries.find((e) => e.id === "rail.prev")).toMatchObject({ binding: "k", isDefault: true });
    expect(shortcutKeys(rail.find((s) => s.id === "rail.next")!, { "rail.next": "mod+j" })).toMatch(/J/);
  });

  it("leaves dispatch to the rail's own handler", () => {
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "j" }))).toBe(false);
  });
});
