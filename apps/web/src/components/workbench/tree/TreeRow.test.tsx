import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MAX_INDENT, TreeRow } from "./TreeRow.tsx";

afterEach(cleanup);

function renderAt(depth: number) {
  render(
    <ul>
      <TreeRow
        row={{ entry: { name: "a.ts", path: "src/a.ts", kind: "file" }, depth, expanded: false }}
        selected={false}
        onOpen={() => undefined}
        onSelect={() => undefined}
        onContextMenu={() => undefined}
      />
    </ul>,
  );
  return screen.getByRole("treeitem");
}

describe("TreeRow", () => {
  it("indents through data-depth, never an inline style", () => {
    const row = renderAt(3);
    expect(row.getAttribute("data-depth")).toBe("3");
    expect(row.getAttribute("style")).toBeNull();
    expect(row.getAttribute("aria-level")).toBe("4");
  });

  it("clamps the indent level at MAX_INDENT", () => {
    const row = renderAt(20);
    expect(row.getAttribute("data-depth")).toBe(String(MAX_INDENT));
    expect(row.getAttribute("aria-level")).toBe("21");
  });
});
