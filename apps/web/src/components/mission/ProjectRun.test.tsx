import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RunRepo } from "@tide/contracts";
import { ProjectRun } from "./ProjectRun.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

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
});
