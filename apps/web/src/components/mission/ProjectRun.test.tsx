import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RunRepo } from "@tide/contracts";
import { ProjectRun } from "./ProjectRun.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useEnvironments } from "../../state/environments.ts";
import { activeTab, resetWorkbench } from "../../state/workbench.ts";

const owners = vi.hoisted(() => ({ projects: {} as Record<string, string>, threads: {} as Record<string, string> }));
vi.mock("../../state/environments.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../state/environments.ts")>()),
  envOfProject: (id: string) => owners.projects[id],
  envOfThread: (id: string) => owners.threads[id],
}));

const hooks = vi.hoisted(() => ({ repos: [] as unknown[], session: undefined as unknown }));
vi.mock("../../state/run.ts", () => ({
  useRunProfiles: () => ({ repos: hooks.repos, loading: false, error: undefined, refresh: () => {}, rescan: async () => {} }),
  useRunSession: () => hooks.session,
}));

afterEach(() => {
  cleanup();
  resetUi();
  hooks.repos = [];
  hooks.session = undefined;
  resetWorkbench();
  owners.projects = {}; owners.threads = {};
  useEnvironments.setState({ environments: [] });
});

const repo = { repoId: "root", repoKey: "app", path: "/a", label: "app", stale: false, profile: { version: 1, repoKey: "app", services: [], source: "user", manifestHash: "", generatedAt: 1, warnings: [] } } as RunRepo;
const st = (state: string) => ({ state, ports: { http: 8081 }, since: 1 });

describe("ProjectRun", () => {
  it("is a quiet 'set up' that opens Settings › Projects when there is no profile", () => {
    attachFakeStore(modelWith({ projects: { p1: { id: "p1", title: "T", rootPath: "/a", createdAt: 1, updatedAt: 1 } } }));
    render(<ProjectRun projectId="p1" />);
    fireEvent.click(screen.getByText("Run · set up"));
    expect(useUi.getState().settingsSection).toBe("projects");
    expect(useUi.getState().view).toBe("settings");
  });

  it("shows up/total and opens the latest thread in split view", () => {
    hooks.repos = [repo];
    hooks.session = { projectId: "p1", startedAt: 1, services: { "app.web": st("ready"), "app.api": st("running"), "app.w": st("failed") } };
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "T", rootPath: "/a", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1", { projectId: "p1" }) },
      }),
    );
    useUi.getState().setFocusMode("thread");
    render(<ProjectRun projectId="p1" />);
    fireEvent.click(screen.getByText("Run · 2/3 up"));
    expect(useUi.getState().selectedThreadId).toBe("t1");
    expect(useUi.getState().focusMode).toBe("split");
  });

  it("opens the preview on the project's remote host", () => {
    useEnvironments.setState({ environments: [{ id: "env-R", name: "R", routes: [{ kind: "lan", url: "ws://192.168.1.20:3777/ws", priority: 0 }], addedAt: 1 }] });
    hooks.repos = [repo];
    hooks.session = { projectId: "p1", startedAt: 1, services: { "app.web": st("ready") } };
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "T", rootPath: "/a", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1", { projectId: "p1" }) },
      }),
    );
    owners.projects = { p1: "env-R" };
    owners.threads = { t1: "env-R" };
    render(<ProjectRun projectId="p1" />);
    fireEvent.click(screen.getByText("Run · 1/1 up"));
    expect(activeTab("t1")).toEqual({ kind: "preview", url: "http://192.168.1.20:8081" });
  });
});
