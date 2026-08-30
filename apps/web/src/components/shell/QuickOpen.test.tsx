import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { threadTabs, useWorkbench } from "../../state/workbench.ts";
import { QuickOpen } from "./QuickOpen.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const TREE: Record<string, { name: string; path: string; kind: "file" | "dir"; ignored?: boolean }[]> = {
  "": [
    { name: "src", path: "src", kind: "dir" },
    { name: "node_modules", path: "node_modules", kind: "dir", ignored: true },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
  src: [
    { name: "app.ts", path: "src/app.ts", kind: "file" },
    { name: "appendix.ts", path: "src/appendix.ts", kind: "file" },
  ],
};

function mount() {
  mockRpc({ "fs.list": ({ path }: { path?: string }) => ({ entries: TREE[path ?? ""] ?? [] }) });
  return render(<QuickOpen threadId="t1" />);
}

describe("QuickOpen", () => {
  it("walks the worktree and skips ignored directories", async () => {
    mount();
    await screen.findByText("README.md");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("ranks the shorter basename match first and opens it on Enter", async () => {
    mount();
    await screen.findByText("README.md");
    const input = screen.getByLabelText("Open file");
    fireEvent.change(input, { target: { value: "app" } });
    const options = screen.getAllByRole("option");
    expect(options[0]?.textContent).toContain("app.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadTabs("t1")).toContainEqual({ kind: "file", path: "src/app.ts" });
    expect(useWorkbench.getState().quickOpen).toBe(false);
  });

  it("moves the selection with the arrow keys", async () => {
    mount();
    await screen.findByText("README.md");
    const input = screen.getByLabelText("Open file");
    fireEvent.change(input, { target: { value: "app" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadTabs("t1")).toContainEqual({ kind: "file", path: "src/appendix.ts" });
  });

  it("closes on Escape", async () => {
    useWorkbench.setState({ quickOpen: true });
    mount();
    await screen.findByText("README.md");
    fireEvent.keyDown(screen.getByLabelText("Open file"), { key: "Escape" });
    expect(useWorkbench.getState().quickOpen).toBe(false);
  });
});
