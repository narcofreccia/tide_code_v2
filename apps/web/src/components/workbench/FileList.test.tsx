import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiffFile } from "@tide/contracts";
import { FileList } from "./FileList.tsx";

const files: DiffFile[] = [
  { path: "src/a.ts", status: "modified", additions: 12, deletions: 3 },
  { path: "src/nested/b.ts", status: "added", additions: 40, deletions: 0 },
  { path: "old.ts", status: "deleted", additions: 0, deletions: 9 },
  { path: "r.ts", oldPath: "q.ts", status: "renamed", additions: 1, deletions: 1 },
];

afterEach(cleanup);

describe("FileList", () => {
  it("renders one row per file with its status glyph and counters", () => {
    render(<FileList files={files} selected="src/a.ts" onSelect={() => {}} collapsed={false} onToggle={() => {}} />);

    expect(screen.getByText("4 files")).toBeDefined();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByLabelText("modified").textContent).toBe("M");
    expect(screen.getByLabelText("added").textContent).toBe("A");
    expect(screen.getByLabelText("deleted").textContent).toBe("D");
    expect(screen.getByLabelText("renamed").textContent).toBe("R");
    expect(screen.getByText("src/nested/")).toBeDefined();
    expect(screen.getByText("b.ts")).toBeDefined();
    expect(screen.getByText("+12")).toBeDefined();
    expect(screen.getByText("−9")).toBeDefined();
    expect(screen.getByTitle("src/a.ts").getAttribute("aria-selected")).toBe("true");
  });

  it("selects on click", () => {
    const onSelect = vi.fn();
    render(<FileList files={files} selected="src/a.ts" onSelect={onSelect} collapsed={false} onToggle={() => {}} />);
    fireEvent.click(screen.getByTitle("old.ts"));
    expect(onSelect).toHaveBeenCalledWith("old.ts");
  });

  it("moves the selection with ArrowDown / ArrowUp", () => {
    const onSelect = vi.fn();
    render(<FileList files={files} selected="src/nested/b.ts" onSelect={onSelect} collapsed={false} onToggle={() => {}} />);
    const list = screen.getByRole("listbox", { name: "Changed files" });

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("old.ts");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("src/a.ts");
  });

  it("collapses to a count", () => {
    const onToggle = vi.fn();
    render(<FileList files={files} selected={undefined} onSelect={() => {}} collapsed onToggle={onToggle} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show files"));
    expect(onToggle).toHaveBeenCalled();
  });
});
