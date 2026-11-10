import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "../components/shell/SplitPane.tsx";
import { TreeResizeHandle } from "../components/workbench/tree/TreeResizeHandle.tsx";
import { TREE_WIDTH, setTreeWidth, useWorkbench } from "../state/workbench.ts";
import { useUi } from "../state/ui.ts";
import { resetUi } from "../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
  setTreeWidth(TREE_WIDTH.default);
});

describe("resize handles from the keyboard", () => {
  it("moves the file tree by 16px with ←/→ and jumps with Home/End", () => {
    render(<TreeResizeHandle />);
    const handle = screen.getByRole("separator", { name: "Resize file tree" });
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuemax"), handle.getAttribute("aria-valuenow")]).toEqual(["160", "480", "220"]);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useWorkbench.getState().treeWidth).toBe(236);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useWorkbench.getState().treeWidth).toBe(204);
    expect(handle.getAttribute("aria-valuenow")).toBe("204");
    fireEvent.keyDown(handle, { key: "End" });
    expect(useWorkbench.getState().treeWidth).toBe(480);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useWorkbench.getState().treeWidth).toBe(480);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useWorkbench.getState().treeWidth).toBe(160);
  });

  it("moves the thread / workbench split and reports it in %", () => {
    useUi.setState({ splitRatio: 0.5 });
    render(<SplitPane primary={<p>thread</p>} secondary={<p>workbench</p>} />);
    const handle = screen.getByRole("separator", { name: "Resize thread and workbench" });
    expect(handle.tabIndex).toBe(0);
    expect([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuemax"), handle.getAttribute("aria-valuenow")]).toEqual(["20", "80", "50"]);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useUi.getState().splitRatio).toBeLessThan(0.5);
    fireEvent.keyDown(handle, { key: "End" });
    expect(useUi.getState().splitRatio).toBe(0.8);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useUi.getState().splitRatio).toBe(0.2);
    expect(handle.getAttribute("aria-valuenow")).toBe("20");
  });
});
