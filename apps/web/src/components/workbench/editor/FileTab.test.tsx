import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockRpc, mockStream, resetUi } from "../../../testHarness.ts";
import { watchDocs } from "../../../state/docs.ts";
import { FileTab } from "./FileTab.tsx";

vi.mock("../monaco/MonacoEditor.tsx", () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

afterEach(() => {
  cleanup();
  resetUi();
});

const file = (content: string, mtime = 100) => () => ({ content, binary: false, size: content.length, mtime });

async function renderTab(handlers: Parameters<typeof mockRpc>[0]) {
  const rpc = mockRpc(handlers);
  const view = render(<FileTab threadId="t1" path="src/a.ts" />);
  const editor = await screen.findByLabelText("editor");
  return { rpc, view, editor: editor as HTMLTextAreaElement };
}

describe("FileTab", () => {
  it("loads the file through fs.read", async () => {
    const { rpc, editor } = await renderTab({ "fs.read": file("hello") });
    expect(rpc).toHaveBeenCalledWith("fs.read", { threadId: "t1", path: "src/a.ts" });
    expect(editor.value).toBe("hello");
  });

  it("shows a notice for a binary file", async () => {
    mockRpc({ "fs.read": () => ({ binary: true, size: 12, mtime: 1 }) });
    render(<FileTab threadId="t1" path="img.png" />);
    expect(await screen.findByText("Binary file — not shown.")).toBeTruthy();
  });

  it("shows a notice past 5 MB", async () => {
    mockRpc({ "fs.read": () => ({ content: "x", binary: false, size: 6_000_000, mtime: 1 }) });
    render(<FileTab threadId="t1" path="big.log" />);
    expect(await screen.findByText(/larger than 5 MB/)).toBeTruthy();
  });

  it("marks the buffer dirty and saves with ifMtime on ⌘S", async () => {
    const { rpc, editor } = await renderTab({
      "fs.read": file("hello", 100),
      "fs.write": () => ({ mtime: 200 }),
    });
    fireEvent.change(editor, { target: { value: "hello world" } });
    expect(screen.getByText("unsaved")).toBeTruthy();

    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("fs.write", {
        threadId: "t1",
        path: "src/a.ts",
        content: "hello world",
        ifMtime: 100,
      }),
    );
    await waitFor(() => expect(screen.queryByText("unsaved")).toBeNull());
  });

  it("raises the conflict banner and can overwrite", async () => {
    let fail = true;
    const rpc = mockRpc({
      "fs.read": file("hello", 100),
      "fs.write": () => {
        if (!fail) return { mtime: 300 };
        const error = Object.assign(new Error("changed on disk"), { code: "conflict" });
        throw error;
      },
    });
    render(<FileTab threadId="t1" path="src/a.ts" />);
    const editor = await screen.findByLabelText("editor");
    fireEvent.change(editor, { target: { value: "mine" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await screen.findByText(/Changed on disk/);

    fail = false;
    fireEvent.click(screen.getByText("Overwrite"));
    await waitFor(() =>
      expect(rpc).toHaveBeenLastCalledWith("fs.write", { threadId: "t1", path: "src/a.ts", content: "mine" }),
    );
    await waitFor(() => expect(screen.queryByText(/Changed on disk/)).toBeNull());
  });

  it("reloads silently when a clean file changes on disk", async () => {
    let disk = "hello";
    mockRpc({ "fs.read": () => ({ content: disk, binary: false, size: disk.length, mtime: 1 }) });
    const { streams } = mockStream();
    const stop = watchDocs("t1");
    render(<FileTab threadId="t1" path="src/a.ts" />);
    const editor = (await screen.findByLabelText("editor")) as HTMLTextAreaElement;

    disk = "written by the agent";
    act(() => streams[0]?.push({ path: "src/a.ts", kind: "modified", at: 2 }));
    await waitFor(() => expect(editor.value).toBe("written by the agent"));
    stop();
  });

  it("warns instead of reloading when the buffer is dirty", async () => {
    mockRpc({ "fs.read": file("hello") });
    const { streams } = mockStream();
    const stop = watchDocs("t1");
    render(<FileTab threadId="t1" path="src/a.ts" />);
    const editor = await screen.findByLabelText("editor");
    fireEvent.change(editor, { target: { value: "mine" } });

    act(() => streams[0]?.push({ path: "src/a.ts", kind: "modified", at: 2 }));
    expect(await screen.findByText(/Changed on disk/)).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("mine");
    stop();
  });
});
