import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const rpcCalls: { method: string; params: unknown; opts: unknown }[] = [];
let rpcReply: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true });
vi.mock("../../state/model.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/model.ts")>()),
  call: (method: string, params: unknown, opts: unknown) => {
    rpcCalls.push({ method, params, opts });
    return rpcReply();
  },
}));

import { useEnvironments } from "../../state/environments.ts";
import { useUi } from "../../state/ui.ts";
import { activeTab, threadTabs, useWorkbench } from "../../state/workbench.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { Markdown } from "./Markdown.tsx";
import { markdownUrlTransform, parseFileLink, relativeToRoot } from "./MarkdownLink.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  rpcCalls.length = 0;
  rpcReply = async () => ({ ok: true });
  useWorkbench.setState({ tabs: {}, active: {}, reveal: {} });
  useEnvironments.setState({ primaryId: undefined, environments: [], statuses: {} } as never);
  vi.restoreAllMocks();
});

describe("markdownUrlTransform & parseFileLink", () => {
  it("keeps file:, http(s):, vscode:, cursor:, and relative links while blocking javascript:/data:", () => {
    expect(markdownUrlTransform("file:///Users/mac/app/Menu.jsx#L42")).toBe("file:///Users/mac/app/Menu.jsx#L42");
    expect(markdownUrlTransform("https://example.com/docs")).toBe("https://example.com/docs");
    expect(markdownUrlTransform("src/components/Menu.jsx#L10-L20")).toBe("src/components/Menu.jsx#L10-L20");
    expect(markdownUrlTransform("javascript:alert(1)")).toBe("");
    expect(markdownUrlTransform("data:text/html,<script>1</script>")).toBe("");
  });

  it("parses file:// URLs, line ranges, colon line numbers, and percent-encoded paths", () => {
    expect(parseFileLink("file:///Users/mac/my%20app/Menu.jsx#L42-L60")).toEqual({
      path: "/Users/mac/my app/Menu.jsx",
      absolute: true,
      line: 42,
    });
    expect(parseFileLink("file:///Users/mac/app/a.ts:15:3")).toEqual({
      path: "/Users/mac/app/a.ts",
      absolute: true,
      line: 15,
      column: 3,
    });
    expect(parseFileLink("./src/App.tsx#L8")).toEqual({
      path: "src/App.tsx",
      absolute: false,
      line: 8,
    });
  });

  it("computes paths relative to a thread worktree or project root", () => {
    expect(relativeToRoot("/repo/src/Menu.jsx", "/repo")).toBe("src/Menu.jsx");
    expect(relativeToRoot("/Users/mac/.gemini/brain/plan.md", "/repo")).toBeUndefined();
  });
});

describe("Markdown link clicks", () => {
  it("preserves file:// href (never blank href='') and opens an in-repo file in the Workbench + switches to split view", async () => {
    const thread = makeThread("t1", { projectId: "p1", worktreePath: "/tmp/wt/t1" });
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Demo", rootPath: "/Users/mac/dev/demo", createdAt: 1, updatedAt: 1 } },
        threads: { t1: thread },
      }),
    );
    useUi.setState({ view: "thread", selectedThreadId: "t1", focusMode: "thread" });

    render(<Markdown text="Fixed in [MenuGraphicStudioDialog.jsx](file:///Users/mac/dev/demo/src/MenuGraphicStudioDialog.jsx#L42)." />);
    const link = screen.getByRole("link", { name: "MenuGraphicStudioDialog.jsx" });
    expect(link.getAttribute("href")).toBe("file:///Users/mac/dev/demo/src/MenuGraphicStudioDialog.jsx#L42");

    fireEvent.click(link);
    await waitFor(() => {
      expect(threadTabs("t1").some((tab) => tab.kind === "file" && tab.path === "src/MenuGraphicStudioDialog.jsx")).toBe(true);
    });
    expect(activeTab("t1")).toEqual({ kind: "file", path: "src/MenuGraphicStudioDialog.jsx" });
    expect(useWorkbench.getState().reveal["t1:src/MenuGraphicStudioDialog.jsx"]).toMatchObject({ line: 42 });
    expect(useUi.getState().focusMode).toBe("split");
  });

  it("opens out-of-workspace file:// links (like Antigravity artifacts) via workspace.openExternal without reloading", async () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useEnvironments.setState({
      primaryId: "env-local",
      environments: [
        {
          id: "env-local",
          name: "Local",
          isLocal: true,
          routes: [{ kind: "local", wsUrl: "ws://127.0.0.1:3777/ws" }],
        },
      ],
      statuses: { "env-local": { state: "connected" } },
    } as never);
    useUi.setState({ view: "thread", selectedThreadId: "t1", focusMode: "thread" });

    render(<Markdown text="Review [creative_upgrade_plan.md](file:///Users/mac/.gemini/antigravity-cli/brain/abc/creative_upgrade_plan.md)." />);
    const link = screen.getByRole("link", { name: "creative_upgrade_plan.md" });
    fireEvent.click(link);

    await waitFor(() => {
      expect(rpcCalls).toEqual([
        {
          method: "workspace.openExternal",
          params: { url: "vscode://file/Users/mac/.gemini/antigravity-cli/brain/abc/creative_upgrade_plan.md" },
          opts: { envId: "env-local" },
        },
      ]);
    });
  });

  it("opens https:// links via workspace.openExternal locally and falls back to window.open when unavailable", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    attachFakeStore(modelWith({}));
    render(<Markdown text="See [docs](https://example.com/guide)." />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.hasAttribute("node")).toBe(false);
    fireEvent.click(link);
    await waitFor(() => {
      expect(rpcCalls).toEqual([{ method: "workspace.openExternal", params: { url: "https://example.com/guide" }, opts: undefined }]);
    });

    rpcReply = async () => ({ ok: false, error: "unavailable" });
    fireEvent.click(link);
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("https://example.com/guide", "_blank", "noopener,noreferrer");
    });
  });
});
