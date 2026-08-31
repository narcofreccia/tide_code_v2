import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReadModel } from "@tide/contracts";
import { CommandPaletteHost } from "./CommandPalette.tsx";
import { TopBar } from "./TopBar.tsx";
import { useKeyboardMap } from "../../lib/useKeyboardMap.ts";
import { loadRecents } from "../../lib/commands.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function fixture(): ReadModel {
  return modelWith({
    projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
    threads: {
      t1: makeThread("t1", { title: "Refactor router" }),
      t2: makeThread("t2", { title: "Docs pass" }),
    },
  });
}

/** The shell in miniature: the global key map plus the palette host. */
function Shell() {
  useKeyboardMap();
  return (
    <>
      <TopBar />
      <CommandPaletteHost />
    </>
  );
}

describe("CommandPalette", () => {
  it("opens on ⌘K and from the top bar button", () => {
    attachFakeStore(fixture());
    render(<Shell />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByLabelText("Command")).toBeDefined();

    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Escape" });
    expect(useUi.getState().paletteOpen).toBe(false);

    fireEvent.click(screen.getByTitle("Command palette"));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("runs the highlighted item on Enter, closes and remembers it", () => {
    attachFakeStore(fixture());
    render(<Shell />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const input = screen.getByLabelText("Command");
    fireEvent.change(input, { target: { value: "Docs pass" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useUi.getState().selectedThreadId).toBe("t2");
    expect(useUi.getState().paletteOpen).toBe(false);
    expect(loadRecents()[0]).toBe("thread:t2");
  });

  it("walks the list with the arrow keys", () => {
    attachFakeStore(fixture());
    render(<Shell />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByLabelText("Command");
    fireEvent.change(input, { target: { value: "focus" } });

    const list = screen.getByLabelText("Commands");
    expect(within(list).getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = within(list).getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    const label = options[1]?.textContent ?? "";
    const expected = label.includes("thread") ? "thread" : label.includes("workbench") ? "workbench" : "split";
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState().focusMode).toBe(expected);
  });
});
