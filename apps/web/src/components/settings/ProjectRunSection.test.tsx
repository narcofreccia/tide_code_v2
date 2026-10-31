import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, RunProfile, RunRepo } from "@tide/contracts";
import { ProjectRunSection, guidePrompt } from "./ProjectRunSection.tsx";
import { parseProfile } from "./RunProfileDialog.tsx";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";

const hooks = vi.hoisted(() => ({ repos: [] as unknown[], rescan: vi.fn(async () => {}), setRunStack: vi.fn(async () => {}) }));
vi.mock("../../state/run.ts", () => ({
  useRunProfiles: () => ({ repos: hooks.repos, loading: false, error: undefined, refresh: () => {}, rescan: hooks.rescan }),
  setRunStack: hooks.setRunStack,
}));

afterEach(() => {
  cleanup();
  resetUi();
  vi.clearAllMocks();
});

const profile: RunProfile = {
  version: 1,
  repoKey: "tide_frontend",
  source: "quickstart",
  manifestHash: "h",
  generatedAt: 1,
  warnings: ["loads .env with override: true"],
  services: [
    {
      id: "web", name: "Web", command: "vite --port 8081 --strictPort", kind: "vite", env: {}, connects: [],
      listens: [{ name: "http", port: 8081, how: "flag", flag: "--port", strictFlag: "--strictPort" }],
      readiness: { kind: "port" },
    },
  ],
};
const repo: RunRepo = { repoId: "root", repoKey: "tide_frontend", path: "/dev/tide_frontend", label: "Frontend", profile, stale: true };
const project: Project = { id: "p1", title: "Tide", rootPath: "/dev/tide_frontend", createdAt: 1, updatedAt: 1 };

function setup() {
  hooks.repos = [repo];
  attachFakeStore(modelWith({ projects: { p1: project } }));
  render(<ProjectRunSection project={project} onBack={() => {}} />);
}

describe("Settings › Run stack", () => {
  it("shows title, repo, stale pill, service command and warnings", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Run stack — Tide" })).toBeDefined();
    expect(screen.getByText("Frontend")).toBeDefined();
    expect(screen.getByText("stale")).toBeDefined();
    expect(screen.getByText("vite --port 8081 --strictPort")).toBeDefined();
    expect(screen.getByText("loads .env with override: true")).toBeDefined();
  });

  it("toggles a service out of the stack and pins a port", () => {
    setup();
    fireEvent.click(screen.getByRole("switch", { name: "Web in stack" }));
    expect(hooks.setRunStack).toHaveBeenCalledWith("p1", { selected: [], pins: {} });
    const input = screen.getByLabelText("Web http port pin");
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    expect(hooks.setRunStack).toHaveBeenLastCalledWith("p1", { selected: ["tide_frontend.web"], pins: { "tide_frontend.web.http": 9000 } });
  });

  it("rescans, and confirms before sending files to the model", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(hooks.rescan).toHaveBeenCalledWith("root", false);
    fireEvent.click(screen.getByRole("button", { name: "Ask the model" }));
    expect(screen.getByText(/Sends the repo's manifests and file tree/)).toBeDefined();
    expect(hooks.rescan).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(hooks.rescan).toHaveBeenLastCalledWith("root", true));
  });

  it("writes QUICKSTART.md through the RPC", async () => {
    const rpc = mockRpc({ "run.quickstart.write": () => ({ path: "/dev/tide_frontend/QUICKSTART.md" }) });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Write QUICKSTART.md" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("run.quickstart.write", { projectId: "p1", repoId: "root" }));
  });
});

describe("profile editing helpers", () => {
  it("validates JSON against the contract", () => {
    expect("profile" in parseProfile(JSON.stringify(profile))).toBe(true);
    expect("error" in parseProfile("{")).toBe(true);
    expect("error" in parseProfile(JSON.stringify({ ...profile, version: 2 }))).toBe(true);
  });
  it("keeps the tide-run block instruction in the agent prompt", () => {
    expect(guidePrompt(profile)).toContain("Keep the existing ```tide-run block exactly as is.");
  });
});
