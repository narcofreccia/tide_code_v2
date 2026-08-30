import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FsEntry } from "@tide/contracts";
import { mockRpc, mockStream, resetUi } from "../../../testHarness.ts";
import { threadTabs } from "../../../state/workbench.ts";
import { FileTree } from "./FileTree.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const entry = (name: string, kind: FsEntry["kind"], dir = "", extra: Partial<FsEntry> = {}): FsEntry => ({
  name,
  path: dir === "" ? name : `${dir}/${name}`,
  kind,
  ...extra,
});

const ROOT = [entry("src", "dir"), entry("README.md", "file"), entry("dist", "dir", "", { ignored: true })];
const SRC = [entry("a.ts", "file", "src"), entry("b.ts", "file", "src")];

function listing() {
  return ({ path }: { path?: string }) => ({ entries: path === "src" ? SRC : ROOT });
}

describe("FileTree", () => {
  it("lists the root, dirs first, and dims ignored entries", async () => {
    mockRpc({ "fs.list": listing() });
    mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("src");
    const names = screen.getAllByRole("treeitem").map((n) => n.textContent);
    expect(names[0]).toContain("dist");
    expect(names[1]).toContain("src");
    expect(names[2]).toContain("README.md");
    expect(screen.getByTitle("dist").className).toMatch(/ignored/);
  });

  it("loads a directory lazily on expand and opens a file tab on click", async () => {
    const rpc = mockRpc({ "fs.list": listing() });
    mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("src");
    expect(rpc).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("src"));
    await screen.findByText("a.ts");
    expect(rpc).toHaveBeenCalledWith("fs.list", { threadId: "t1", path: "src" });

    fireEvent.click(screen.getByTitle("src/a.ts"));
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }, { kind: "file", path: "src/a.ts" }]);
  });

  it("walks with the arrow keys and opens with Enter", async () => {
    mockRpc({ "fs.list": listing() });
    mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("src");
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTitle("README.md").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }, { kind: "file", path: "README.md" }]);
  });

  it("renames through the context menu", async () => {
    const rpc = mockRpc({ "fs.list": listing(), "fs.rename": () => ({ ok: true }) });
    mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByTitle("README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "READ.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("fs.rename", { threadId: "t1", from: "README.md", to: "READ.md" }),
    );
  });

  it("deletes after confirmation", async () => {
    const rpc = mockRpc({ "fs.list": listing(), "fs.delete": () => ({ ok: true }) });
    mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByTitle("README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("fs.delete", { threadId: "t1", path: "README.md" }));
  });

  it("refreshes the affected directory when fs.watch reports a change", async () => {
    let extra = false;
    const rpc = mockRpc({
      "fs.list": ({ path }: { path?: string }) => ({
        entries: path === "src" ? SRC : extra ? [...ROOT, entry("NEW.md", "file")] : ROOT,
      }),
    });
    const { streams } = mockStream();
    render(<FileTree threadId="t1" />);
    await screen.findByText("README.md");
    expect(streams[0]?.method).toBe("fs.watch");

    extra = true;
    act(() => streams[0]?.push({ path: "NEW.md", kind: "created", at: 1 }));
    await screen.findByText("NEW.md");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
