import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@tide/contracts";
import { RpcCallError } from "@tide/client";
import { RepoMachines, baseSummary } from "./RepoMachines.tsx";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useToasts } from "../../state/toast.ts";
import { useEnvironments } from "../../state/environments.ts";

const owners = vi.hoisted(() => ({ projects: {} as Record<string, string> }));
vi.mock("../../state/environments.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../state/environments.ts")>()),
  envOfProject: (id: string) => owners.projects[id],
}));

afterEach(() => {
  cleanup();
  resetUi();
  owners.projects = {};
  useToasts.setState({ toasts: [] });
  useEnvironments.setState({ environments: [], statuses: {} });
});

const repo = { remoteUrl: "github.com/acme/web", cloneUrl: "https://github.com/acme/web.git", defaultBranch: "main", detectedAt: 1 };
const proj = (id: string, withRepo = true): Project => ({ id, title: "web", rootPath: `/${id}`, createdAt: 1, updatedAt: 1, ...(withRepo ? { repo } : {}) });
const base = { branch: "main", dirty: false, hasRemote: true };

describe("RepoMachines", () => {
  it("summarises the base branch", () => {
    expect(baseSummary({ ...base, ahead: 1, behind: 2 })).toBe("main · ahead 1 · behind 2");
    expect(baseSummary({ ...base, ahead: 0, behind: 0 })).toBe("main · up to date");
    expect(baseSummary({ ...base, hasRemote: false })).toBe("main · no remote");
  });

  it("draws nothing for a project without a remote", () => {
    attachFakeStore(modelWith({}));
    const { container } = render(<RepoMachines projects={[proj("a", false)]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows one status row per clone and pulls on that machine", async () => {
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({
      "vcs.baseStatus": ((p: { projectId: string }) => (p.projectId === "a" ? { ...base, ahead: 1, behind: 2 } : { ...base, ahead: 0, behind: 0 })) as never,
      "vcs.pullBase": (() => ({ ok: true, sha: "abc" })) as never,
    });
    render(<RepoMachines projects={[proj("a"), proj("b")]} />);
    await waitFor(() => expect(screen.getByText("main · ahead 1 · behind 2")).toBeDefined());
    expect(screen.getByText("main · up to date")).toBeDefined();
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: /^Pull on/ })[0] as HTMLElement));
    expect(rpc).toHaveBeenCalledWith("vcs.pullBase", { projectId: "a" });
  });

  it("toasts a failed pull and survives a server without the method", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({
      "vcs.baseStatus": (() => ({ ...base, ahead: 0, behind: 1 })) as never,
      "vcs.pullBase": (() => ({ ok: false, error: "diverged" })) as never,
    });
    render(<RepoMachines projects={[proj("a")]} />);
    await waitFor(() => expect(screen.getByText("main · behind 1")).toBeDefined());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pull on web" })));
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Pull failed: diverged"]);
    cleanup();
    mockRpc({
      "vcs.baseStatus": (() => {
        throw new RpcCallError({ code: "method-not-found", message: "unknown method vcs.baseStatus" });
      }) as never,
    });
    render(<RepoMachines projects={[proj("a")]} />);
    await waitFor(() => expect(screen.getByText("update this machine to sync")).toBeDefined());
    expect((screen.getByRole("button", { name: "Pull on web" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
