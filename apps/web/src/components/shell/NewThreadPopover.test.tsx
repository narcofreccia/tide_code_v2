import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../state/environments.ts", async () => (await import("../fleet/testEnvironments.ts")).fakeEnvironmentsModule());

import type { ProviderStatusDto } from "@tide/contracts";
import * as envs from "../../state/environments.ts";
import { twoMachines } from "../fleet/testEnvironments.ts";
import { NewThreadDialogHost } from "./NewThreadPopover.tsx";
import { attachFakeStore, chooseOption, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { defaultUserSettings, resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { setDispatcher, type DispatchResult } from "../../state/model.ts";
import { resetProviders, setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { createChild } from "../../lib/threadActions.ts";

const projectEnvs = (envs as unknown as { projectEnvs: Record<string, string> }).projectEnvs;

afterEach(() => {
  cleanup();
  resetUi();
  resetServerSettings();
  setDispatcher(undefined);
  envs.useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  for (const key of Object.keys(projectEnvs)) delete projectEnvs[key];
  vi.clearAllMocks();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function open(parentThreadId?: string, threads?: Record<string, ReturnType<typeof makeThread>>) {
  const fake = attachFakeStore(
    modelWith({
      projects: { p1: project },
      threads: threads ?? { t1: makeThread("t1", { title: "Parent", provider: "codex" }) },
    }),
  );
  render(<NewThreadDialogHost />);
  act(() => useUi.getState().openNewThread({ projectId: "p1", ...(parentThreadId ? { parentThreadId } : {}) }));
  return fake;
}

async function created(fake: ReturnType<typeof open>): Promise<Record<string, unknown>> {
  await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
  return fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("new thread form", () => {
  it("leaves the title to the first message unless one is typed", async () => {
    const fake = open();
    const title = screen.getByLabelText("Thread title") as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect(screen.getByText("Optional. Named from your first message otherwise.")).toBeDefined();
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["title"]).toBe("New thread");
  });

  it("states the outcome: project in the heading, permission hint as caption", () => {
    open();
    expect(screen.getByRole("heading", { name: "Start a thread on Tide" })).toBeDefined();
    chooseOption("Thread permissions", "Full access");
    expect(screen.getByText("Never asks — use with care")).toBeDefined();
  });

  it("⌘↵ creates from any field", async () => {
    const fake = open();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Plan" }), { key: "Enter", metaKey: true });
    expect((await created(fake))["type"]).toBe("thread.create");
  });

  it("sends a typed title", async () => {
    const fake = open();
    fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "  Fix login  " } });
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["title"]).toBe("Fix login");
  });

  it("offers the four permission modes and sends the chosen one", async () => {
    const fake = open();
    chooseOption("Thread permissions", "Full access");
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["mode"]).toBe("full-access");
  });

  it("defaults permissions to the Settings › Providers default", () => {
    useServerSettings.setState((s) => ({
      settings: { ...s.settings, providerDefaults: { claude: { mode: "auto-accept-edits" } } },
    }));
    open(undefined, {});
    expect(screen.getByRole("combobox", { name: "Thread permissions" }).textContent).toContain("Auto-edit");
  });

  it("defaults agent, model and permissions to the project's most recent thread", async () => {
    const fake = open(undefined, {
      old: makeThread("old", { provider: "claude", createdAt: 1 }),
      recent: makeThread("recent", { provider: "codex", model: "gpt-x", mode: "full-access", createdAt: 5 }),
    });
    fireEvent.click(screen.getByText("Create thread"));
    const cmd = await created(fake);
    expect(cmd["provider"]).toBe("codex");
    expect(cmd["model"]).toBe("gpt-x");
    expect(cmd["mode"]).toBe("full-access");
  });

  it("switches Build | Plan and sends interaction plan", async () => {
    const fake = open();
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["interaction"]).toBe("plan");
  });

  it("creates a child prefilled from the parent and honours worktreeByDefault", async () => {
    useServerSettings.setState((s) => ({ settings: { ...s.settings, worktreeByDefault: false } }));
    const fake = open("t1");
    expect(screen.getByRole("dialog", { name: "New child thread" })).toBeDefined();
    expect(screen.getByText("Child of “Parent”")).toBeDefined();
    fireEvent.click(screen.getByText("Create child thread"));
    const command = await created(fake);
    expect(command).toMatchObject({ type: "thread.create", parentThreadId: "t1", provider: "codex", useWorktree: false });
  });

  it("createChild opens the form instead of creating silently", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    createChild({ id: "t1", projectId: "p1" });
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    expect(useUi.getState().newThreadParentId).toBe("t1");
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("openNewThread finds the project from the parent alone", () => {
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    useUi.getState().openNewThread({ parentThreadId: "t1" });
    expect(useUi.getState().newThreadProjectId).toBe("p1");
  });
});

const repo = { remoteUrl: "github.com/acme/tide", cloneUrl: "git@github.com:acme/tide.git", defaultBranch: "main", detectedAt: 1 };

/** p1 (with its repo) lives on the laptop; `extra` adds projects on other machines. */
function openRunOn(extra: Record<string, typeof project & { repo?: typeof repo }> = {}, withRepo = true) {
  envs.useEnvironments.setState(twoMachines());
  projectEnvs["p1"] = "env-a";
  const projects = { p1: { ...project, ...(withRepo ? { repo } : {}) }, ...extra };
  attachFakeStore(modelWith({ projects, threads: {} }));
  const dispatch = vi.fn(async (): Promise<DispatchResult> => ({ seq: 1, events: [] }));
  setDispatcher(dispatch);
  render(<NewThreadDialogHost />);
  act(() => useUi.getState().openNewThread({ projectId: "p1" }));
  return dispatch;
}

describe("new thread form · run on another machine", () => {
  it("keeps the read-only line without a repo, offers the picker with a repo and two machines", () => {
    openRunOn({}, false);
    expect(screen.queryByRole("combobox", { name: "Run on" })).toBeNull();
    expect(screen.getByText("laptop")).toBeDefined();
    cleanup();
    openRunOn();
    expect(screen.getByRole("combobox", { name: "Run on" }).textContent).toContain("laptop");
    expect(screen.getByText("Runs on this machine's checkout")).toBeDefined();
  });

  it("no picker with one connected machine", () => {
    openRunOn();
    cleanup();
    envs.useEnvironments.setState((s) => ({ statuses: { ...s.statuses, "env-b": { connection: "offline" as const } } }));
    render(<NewThreadDialogHost />);
    expect(screen.queryByRole("combobox", { name: "Run on" })).toBeNull();
  });

  it("uses the clone another machine already has", async () => {
    const dispatch = openRunOn({ p2: { ...project, id: "p2", title: "tide (box)", rootPath: "/home/me/tide", repo } });
    projectEnvs["p2"] = "env-b";
    chooseOption("Run on", /^box/);
    expect(screen.getByText("Uses tide (box) on box")).toBeDefined();
    fireEvent.click(screen.getByText("Create thread"));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch.mock.calls[0]).toEqual([expect.objectContaining({ type: "thread.create", projectId: "p2" }), { envId: "env-b" }]);
  });

  it("clones onto the chosen machine, then creates the thread there", async () => {
    useServerSettings.setState({ byEnv: { "env-b": { settings: { ...defaultUserSettings(), environment: { name: "box", projectsDir: "/srv/repos" } }, loaded: true } } });
    let finish: (value: { projectId: string; rootPath: string; cloned: boolean }) => void = () => undefined;
    const caller = mockRpc({ "project.ensure": () => new Promise((resolve) => (finish = resolve)) });
    const dispatch = openRunOn();
    chooseOption("Run on", /^box/);
    expect(screen.getByText(/Clones acme\/tide onto box into \/srv\/repos/)).toBeDefined();
    expect(screen.getByText(/Linked repositories are not carried over/)).toBeDefined();
    fireEvent.click(screen.getByText("Create thread"));
    const busy = await screen.findByRole("button", { name: "Cloning onto box…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(caller).toHaveBeenCalledWith(
      "project.ensure",
      { repo: { remoteUrl: repo.remoteUrl, cloneUrl: repo.cloneUrl, defaultBranch: "main" }, title: "Tide" },
      { envId: "env-b" },
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => finish({ projectId: "p9", rootPath: "/srv/repos/tide", cloned: true }));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch.mock.calls[0]).toEqual([expect.objectContaining({ type: "thread.create", projectId: "p9" }), { envId: "env-b" }]);
    await waitFor(() => expect(useUi.getState().newThreadProjectId).toBeNull());
  });

  it("omits the clone folder until that machine's settings have loaded", () => {
    openRunOn();
    chooseOption("Run on", /^box/);
    const caption = screen.getByText(/Clones acme\/tide onto box/);
    expect(caption.textContent).not.toContain(" into ");
  });
});

describe("new thread form · plan mode (C1)", () => {
  const acp: ProviderStatusDto = {
    id: "acp-gemini",
    kind: "acp",
    label: "Gemini",
    installed: true,
    loggedIn: true,
    models: [],
    caps: { planMode: false, subagents: false, mcp: true, images: false, resume: false, contextUsage: false, openInTerminal: false },
  };

  it("hides Plan for a harness without plan mode and resets to Build", async () => {
    setProvidersForTest([...PROVIDER_FIXTURE, acp]);
    const fake = open(undefined, {});
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    expect(screen.getByRole("radio", { name: "Plan" }).getAttribute("aria-checked")).toBe("true");
    chooseOption("Thread provider", /^Gemini/);
    expect(screen.queryByRole("radio", { name: "Plan" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    chooseOption("Thread provider", /^Claude Code/);
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["interaction"]).toBeUndefined();
  });
});

describe("new thread form: harness readiness", () => {
  afterEach(() => resetProviders());
  const caps = PROVIDER_FIXTURE[0]!.caps;
  const status = (id: "claude" | "codex", installed: boolean, loggedIn: boolean, extra: Partial<ProviderStatusDto> = {}): ProviderStatusDto => ({
    id, kind: id, label: id === "claude" ? "Claude Code" : "Codex", installed, loggedIn, models: [], caps, ...extra,
  });

  it("starts a Codex-only user on Codex instead of an absent Claude", async () => {
    setProvidersForTest([status("claude", false, false), status("codex", true, true)]);
    const fake = open(undefined, {});
    expect(screen.getByRole("combobox", { name: "Thread provider" }).textContent).toContain("Codex");
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["provider"]).toBe("codex");
  });

  it("blocks Create with the reason and offers the fix when the chosen harness is signed out", () => {
    setProvidersForTest([status("claude", false, false), status("codex", true, false, { loginCommand: "codex login" })]);
    const fake = open();
    const create = screen.getByText("Create thread").closest("button") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getAllByText(/Codex is not logged in/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Log in" }).getAttribute("title")).toBe("codex login");
    fireEvent.click(create);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("says how to install a missing harness", () => {
    setProvidersForTest([
      status("claude", false, false, { install: { command: "npm i -g @anthropic-ai/claude-code" } } as Partial<ProviderStatusDto>),
      status("codex", false, false),
    ]);
    open(undefined, {});
    expect(screen.getAllByText(/Claude Code is not installed/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Copy install command" })).toBeDefined();
  });

  it("does not block while the roster is still unknown", async () => {
    const fake = open();
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["type"]).toBe("thread.create");
  });
});
