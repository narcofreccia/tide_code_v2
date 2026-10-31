import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockRpc, mockStream, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useFiles } from "../../state/files.ts";
import { DEFAULT_TREE, resetWorkbench, toggleTree, useTreeVisible, useWorkbench } from "../../state/workbench.ts";
import { FileTab } from "./editor/FileTab.tsx";
import { AddMenu } from "./AddMenu.tsx";

vi.mock("./monaco/MonacoEditor.tsx", () => ({ MonacoEditor: () => <textarea aria-label="editor" /> }));

afterEach(() => {
  cleanup();
  resetUi();
  resetWorkbench();
});

function TreeProbe() {
  return <span data-testid="tree">{useTreeVisible() ? "open" : "closed"}</span>;
}

describe("Files toggle", () => {
  it("is open by default in Code, closed in Split, and remembers each layout's choice", () => {
    expect(DEFAULT_TREE).toEqual({ split: false, code: true });
    act(() => useUi.getState().setFocusMode("split"));
    render(<TreeProbe />);
    expect(screen.getByTestId("tree").textContent).toBe("closed");

    act(() => useUi.getState().setFocusMode("workbench"));
    expect(screen.getByTestId("tree").textContent).toBe("open");
    act(() => toggleTree());
    expect(screen.getByTestId("tree").textContent).toBe("closed");

    act(() => useUi.getState().setFocusMode("split"));
    expect(screen.getByTestId("tree").textContent).toBe("closed");
    act(() => toggleTree());
    expect(screen.getByTestId("tree").textContent).toBe("open");

    act(() => useUi.getState().setFocusMode("workbench"));
    expect(screen.getByTestId("tree").textContent).toBe("closed");
    expect(useWorkbench.getState().treeByMode).toEqual({ split: true, code: false });
  });
});

describe("Breadcrumbs", () => {
  it("opens the tree on a folder segment; the file name is plain", async () => {
    mockRpc({
      "fs.read": () => ({ content: "x", binary: false, size: 1, mtime: 1 }),
      "fs.list": () => ({ entries: [] }),
    });
    mockStream();
    act(() => useUi.getState().setFocusMode("split"));
    render(<FileTab threadId="t1" path="src/lib/a.ts" />);
    await screen.findByLabelText("editor");
    expect(screen.queryByRole("button", { name: "a.ts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "lib" }));
    expect(useWorkbench.getState().treeByMode.split).toBe(true);
    const files = useFiles.getState();
    expect(files.selected.t1).toBe("src/lib");
    expect(Object.entries(files.expanded).filter(([, v]) => v).map(([k]) => k).sort()).toEqual(
      expect.arrayContaining([expect.stringContaining("src"), expect.stringContaining("src/lib")]),
    );
  });
});

describe("Add menu", () => {
  it("lists quick open, search and a new terminal", () => {
    mockRpc({});
    render(<AddMenu threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Open file…⌘P", "Search in files…⌘⇧F", "New terminal"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Open file/ }));
    expect(useWorkbench.getState().quickOpen).toBe(true);
  });
});
