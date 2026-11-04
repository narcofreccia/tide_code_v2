import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setTreeWidth, useWorkbench } from "../../../state/workbench.ts";
import { TreeResizeHandle } from "./TreeResizeHandle.tsx";

afterEach(() => {
  cleanup();
  setTreeWidth(220);
});

describe("TreeResizeHandle", () => {
  it("renders a vertical separator", () => {
    render(<TreeResizeHandle />);
    const handle = screen.getByRole("separator", { name: "Resize file tree" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("double-click resets the tree width to 220", () => {
    setTreeWidth(400);
    render(<TreeResizeHandle />);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(useWorkbench.getState().treeWidth).toBe(220);
  });
});
