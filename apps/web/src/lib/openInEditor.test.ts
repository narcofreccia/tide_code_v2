import { describe, expect, it, vi } from "vitest";
import { emptyReadModel, type Thread } from "@tide/contracts";

vi.mock("../state/environments.ts", async () => {
  const { create } = await import("zustand");
  return {
    useEnvironments: create(() => ({ environments: [], statuses: {}, primaryId: undefined })),
    envOfThread: (id: string) => (id === "t-remote" ? "env-b" : "env-a"),
  };
});

const calls: { method: string; params: unknown; opts: unknown }[] = [];
let reply: () => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true });
vi.mock("../state/model.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/model.ts")>()),
  call: (method: string, params: unknown, opts: unknown) => {
    calls.push({ method, params, opts });
    return reply();
  },
}));
const toasts: string[] = [];
vi.mock("../state/toast.ts", () => ({ showToast: (text: string) => toasts.push(text) }));

import { editorBlockedReason, editorUrl, launchEditorUrl, threadEditorTarget } from "./openInEditor.ts";

describe("editorUrl", () => {
  it("opens a local folder with the file scheme", () => {
    expect(editorUrl("vscode", { path: "/Users/me/repo/.tide/wt/a b", local: true })).toBe(
      "vscode://file/Users/me/repo/.tide/wt/a%20b",
    );
    expect(editorUrl("cursor", { path: "/srv/x", local: true })).toBe("cursor://file/srv/x");
  });

  it("opens a remote folder over Remote-SSH when an SSH host is known", () => {
    expect(editorUrl("vscode", { path: "/home/dev/repo", local: false, sshHost: "dev@box.ts.net" })).toBe(
      "vscode://vscode-remote/ssh-remote+dev@box.ts.net/home/dev/repo",
    );
    expect(editorUrl("cursor", { path: "/home/dev/repo", local: false, sshHost: "box" })).toBe(
      "cursor://vscode-remote/ssh-remote+box/home/dev/repo",
    );
  });

  it("has no URL for a remote folder without an SSH host", () => {
    const target = { path: "/home/dev/repo", local: false };
    expect(editorUrl("vscode", target)).toBeUndefined();
    expect(editorBlockedReason(target)).toMatch(/SSH host/);
    expect(editorBlockedReason({ ...target, sshHost: "box" })).toBeUndefined();
  });
});

describe("threadEditorTarget", () => {
  const model = emptyReadModel();
  model.projects.p1 = { id: "p1", title: "P", rootPath: "/repo" } as never;
  const thread = (id: string, worktreePath?: string): Thread =>
    ({ id, projectId: "p1", ...(worktreePath ? { worktreePath } : {}) }) as Thread;
  const state = {
    primaryId: "env-a",
    environments: [
      { id: "env-a", name: "laptop", routes: [{ kind: "local" as const, url: "ws://127.0.0.1:3777/ws", priority: 0 }], addedAt: 1 },
      { id: "env-b", name: "box", routes: [{ kind: "lan" as const, url: "ws://192.168.1.9:3777/ws", priority: 0 }], addedAt: 1, sshHost: "me@box" },
    ],
    statuses: {},
  };

  it("uses the worktree on the local machine, else the project root", () => {
    expect(threadEditorTarget(model, thread("t1", "/repo/.wt/t1"), state)).toEqual({ path: "/repo/.wt/t1", local: true, sshHost: undefined });
    expect(threadEditorTarget(model, thread("t1"), state)?.path).toBe("/repo");
  });

  it("marks a thread on another machine as remote with that machine's SSH host", () => {
    expect(threadEditorTarget(model, thread("t-remote", "/w"), state)).toEqual({ path: "/w", local: false, sshHost: "me@box" });
  });
});

describe("launchEditorUrl", () => {
  const state = {
    primaryId: "env-a",
    environments: [
      { id: "env-a", name: "laptop", routes: [{ kind: "local" as const, url: "ws://127.0.0.1:3777/ws", priority: 0 }], addedAt: 1 },
      { id: "env-b", name: "box", routes: [{ kind: "lan" as const, url: "ws://192.168.1.9:3777/ws", priority: 0 }], addedAt: 1 },
    ],
    statuses: {},
  };
  const assign = vi.fn();
  const reset = (): void => {
    calls.length = 0;
    toasts.length = 0;
    assign.mockReset();
    vi.stubGlobal("location", { ...window.location, assign });
  };

  it("asks the local server to open the URL and stays put on success", async () => {
    reset();
    reply = async () => ({ ok: true });
    await launchEditorUrl("vscode://file/repo", { threadId: "t1" }, state);
    expect(calls).toEqual([{ method: "workspace.openExternal", params: { url: "vscode://file/repo" }, opts: { envId: "env-a" } }]);
    expect(assign).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it("toasts the server's reason and falls back to the browser handoff", async () => {
    reset();
    reply = async () => ({ ok: false, error: "VS Code is not installed (vscode:// has no handler)" });
    await launchEditorUrl("vscode://file/repo", { threadId: "t1" }, state);
    expect(toasts).toEqual(["VS Code is not installed (vscode:// has no handler)"]);
    expect(assign).toHaveBeenCalledWith("vscode://file/repo");
  });

  it("hands a remote thread's link straight to the browser", async () => {
    reset();
    await launchEditorUrl("vscode://vscode-remote/ssh-remote+box/w", { threadId: "t-remote" }, state);
    expect(calls).toEqual([]);
    expect(assign).toHaveBeenCalledWith("vscode://vscode-remote/ssh-remote+box/w");
    vi.unstubAllGlobals();
  });
});
