import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NO_SERVER, PreviewMenu, SERVER_HELP, manualPreviewUrl } from "./PreviewMenu.tsx";
import { PreviewTab, normalizePreviewUrl, previewSandbox } from "./PreviewTab.tsx";
import { activeTab, openPreviewTab, resetWorkbench, threadTabs } from "../../../state/workbench.ts";
import { attachFakeStore, makeThread, mockRpc, mockStream, modelWith, resetUi } from "../../../testHarness.ts";
import { useModel } from "../../../state/model.ts";
import { resetRun } from "../../../state/run.ts";
import { emptyReadModel } from "@tide/contracts";

afterEach(() => {
  cleanup();
  resetRun();
  resetUi();
  useModel.setState({ model: emptyReadModel() });
  resetWorkbench();
});

describe("Preview", () => {
  it("lists the thread's ports and opens one as a preview tab", async () => {
    const rpc = mockRpc({
      "ports.list": () => ({ ports: [{ port: 5173, pid: 42, command: "vite", url: "http://localhost:5173" }] }),
    });
    render(<PreviewMenu threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /5173/ }));
    expect(rpc).toHaveBeenCalledWith("ports.list", { threadId: "t1" });
    expect(activeTab("t1")).toEqual({ kind: "preview", url: "http://localhost:5173" });
  });

  it("says how to get a dev server when none listens, refreshes, and previews a typed URL", async () => {
    const rpc = mockRpc({ "ports.list": () => ({ ports: [] }) });
    render(<PreviewMenu threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(NO_SERVER)).toBeDefined();
    const before = rpc.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(rpc.mock.calls.length).toBe(before + 1);
    const field = screen.getByLabelText("Preview a URL");
    fireEvent.change(field, { target: { value: "4321" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(activeTab("t1")).toEqual({ kind: "preview", url: "http://localhost:4321" });
    expect(manualPreviewUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
  });

  it("keeps one preview tab per thread and retargets it from the URL bar", () => {
    openPreviewTab("t1", "http://localhost:3000");
    render(<PreviewTab threadId="t1" url="http://localhost:3000" />);
    const frame = screen.getByTitle("Preview") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("http://localhost:3000");
    expect(screen.getByRole("link", { name: "Open in browser" }).getAttribute("href")).toBe("http://localhost:3000");
    const url = screen.getByLabelText("Preview URL");
    fireEvent.change(url, { target: { value: "localhost:3000/about" } });
    fireEvent.submit(url.closest("form") as HTMLFormElement);
    expect(threadTabs("t1").filter((t) => t.kind === "preview")).toEqual([
      { kind: "preview", url: "http://localhost:3000/about" },
    ]);
  });

  it("never grants same-origin to a page on Tide's own origin", () => {
    expect(previewSandbox("http://127.0.0.1:59999/")).toContain("allow-same-origin");
    expect(previewSandbox(window.location.origin)).not.toContain("allow-same-origin");
    expect(normalizePreviewUrl(" https://x.dev ")).toBe("https://x.dev");
  });

  it("puts the project's run stack under the empty state and above a live preview", async () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { projectId: "p1" }) } }));
    mockRpc({ "ports.list": () => ({ ports: [] }), "run.profiles.get": () => ({ repos: [] }) });
    mockStream();
    render(<PreviewMenu threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByLabelText("Run stack")).toBeDefined();
    cleanup();
    render(<PreviewTab threadId="t1" url="http://localhost:3000" />);
    const strip = screen.getByLabelText("Run stack");
    // folded by default over a live preview
    expect(screen.getByRole("button", { name: "Run" }).getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toContain("0/0 up");
  });

  it("opens as a wide panel on the button's end edge with a one-line empty state and the help under the URL field", async () => {
    mockRpc({ "ports.list": () => ({ ports: [] }) });
    render(<PreviewMenu threadId="t1" />);
    const trigger = screen.getByRole("button", { name: "Preview" });
    (trigger.parentElement as HTMLElement).getBoundingClientRect = () => ({ top: 0, bottom: 28, left: 700, right: 760, width: 60, height: 28, x: 700, y: 0, toJSON: () => ({}) });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog");
    expect(panel.className).toMatch(/panel/);
    expect(panel.style.left).toBe("760px");
    const note = await screen.findByText(NO_SERVER);
    expect(note.getAttribute("title")).toBe(SERVER_HELP);
    expect(note.className).toMatch(/note/);
    const form = screen.getByLabelText("Preview a URL").closest("form") as HTMLFormElement;
    expect(form.textContent).toContain(SERVER_HELP);
  });
});
