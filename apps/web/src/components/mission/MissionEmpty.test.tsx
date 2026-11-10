import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProviderStatusDto } from "@tide/contracts";
import { MissionControl } from "./MissionControl.tsx";
import { harnessStep } from "./MissionEmpty.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { resetProviders, setProvidersForTest } from "../../state/providers.ts";
import { setRpcCaller } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetProviders();
  setRpcCaller(undefined);
});

const caps = {
  planMode: true,
  subagents: true,
  mcp: true,
  images: true,
  resume: true,
  contextUsage: true,
  openInTerminal: true,
};

type Dto = ProviderStatusDto & { install?: { command?: string; url?: string } };

function dto(id: "claude" | "codex" | "opencode" | "pi", label: string, installed: boolean, loggedIn: boolean, extra: Partial<Dto> = {}): Dto {
  return { id, kind: id, label, installed, loggedIn, models: [], caps, ...extra };
}

const NOTHING_INSTALLED: Dto[] = [
  dto("claude", "Claude Code", false, false, { install: { command: "npm i -g @anthropic-ai/claude-code", url: "https://claude.com/claude-code" } }),
  dto("codex", "Codex", false, false, { install: { command: "npm i -g @openai/codex" } }),
  dto("opencode", "OpenCode", false, false),
  dto("pi", "Pi", false, false),
];

function providers(loggedIn: boolean) {
  setProvidersForTest([
    dto("claude", "Claude Code", true, loggedIn, loggedIn ? {} : { loginCommand: "claude auth login" }),
    dto("codex", "Codex", false, false),
    dto("opencode", "OpenCode", false, false),
    dto("pi", "Pi", true, false, { hint: "Start pi and sign in with /login" }),
  ]);
}

const steps = () => within(screen.getByLabelText("Getting started")).getAllByRole("listitem").filter((li) => li.parentElement === screen.getByLabelText("Getting started"));

describe("Mission Control empty state", () => {
  it("shows the mark, the sentence and a checklist that no step is done in", () => {
    providers(false);
    attachFakeStore(modelWith({}));
    const { container } = render(<MissionControl />);
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("40");
    expect(screen.getByText("Tide")).toBeDefined();
    expect(screen.getByText("Threads on any coding harness, each on its own worktree.")).toBeDefined();

    expect(steps()).toHaveLength(3);
    for (const step of ["1 Add a repository", "2 Log in to Claude Code or Pi", "3 Start a thread"]) {
      expect(screen.getByLabelText(step).dataset["done"]).toBe("false");
    }
    // step 3 cannot run before step 1
    expect((screen.getByText("New thread").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks to install a harness when none is, listing each install command with Copy and docs", () => {
    setProvidersForTest(NOTHING_INSTALLED);
    attachFakeStore(modelWith({}));
    render(<MissionControl />);
    expect(screen.getByLabelText("2 Install a harness").dataset["done"]).toBe("false");
    const list = screen.getByRole("list", { name: "Install a harness" });
    const rows = within(list).getAllByRole("listitem");
    // only the harnesses the server gave install steps for
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Claude Code"), expect.stringContaining("Codex")]);
    expect(within(list).getByText("npm i -g @openai/codex")).toBeDefined();
    expect(within(list).getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    expect(within(list).getByRole("link", { name: "Claude Code docs" }).getAttribute("href")).toBe("https://claude.com/claude-code");
  });

  it("asks to log in to the installed ones, with each login command or its hint", () => {
    providers(false);
    attachFakeStore(modelWith({}));
    render(<MissionControl />);
    const list = screen.getByRole("list", { name: "Log in to a harness" });
    expect(within(list).getByText("claude auth login")).toBeDefined();
    expect(within(list).getByText("Start pi and sign in with /login")).toBeDefined();
    expect(within(list).queryByText(/Codex/)).toBeNull();
  });

  it("ticks the harness step off and names which are ready", () => {
    providers(true);
    attachFakeStore(modelWith({}));
    render(<MissionControl />);
    expect(screen.getByLabelText("2 Set up a harness").dataset["done"]).toBe("true");
    expect(screen.getByText("Ready: Claude Code")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.getByLabelText("1 Add a repository").dataset["done"]).toBe("false");
  });

  it("counts an ACP agent the server reports like any other harness", () => {
    setProvidersForTest([...NOTHING_INSTALLED, { id: "acp:gemini", kind: "acp", label: "Gemini", installed: true, loggedIn: true, models: [], caps }]);
    attachFakeStore(modelWith({}));
    render(<MissionControl />);
    expect(screen.getByText("Ready: Gemini")).toBeDefined();
  });

  it("Refresh re-reads the roster past the server's cache", async () => {
    providers(false);
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({ "providers.list": () => [dto("claude", "Claude Code", true, true)] });
    render(<MissionControl />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(rpc).toHaveBeenCalledWith("providers.list", { refresh: true });
    await waitFor(() => expect(screen.getByText("Ready: Claude Code")).toBeDefined());
  });

  it("re-reads on window focus while incomplete, and stops listening once a harness is usable", async () => {
    providers(false);
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({ "providers.list": () => [dto("claude", "Claude Code", true, true)] });
    render(<MissionControl />);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByText("Ready: Claude Code")).toBeDefined());
    const calls = rpc.mock.calls.filter(([m]) => m === "providers.list").length;
    expect(calls).toBe(1);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(rpc.mock.calls.filter(([m]) => m === "providers.list").length).toBe(calls);
  });

  it("says when git is missing on the server", async () => {
    providers(true);
    attachFakeStore(modelWith({}));
    mockRpc({
      "server.info": () => ({ environmentId: "e", name: "studio", version: "1.0.0", startedAt: 1, tools: { git: false, gh: true, rg: true } }),
    });
    render(<MissionControl />);
    expect(await screen.findByText("git is not installed on studio; threads cannot use worktrees.")).toBeDefined();
  });

  it("opens the rail's add-project form from the first step", () => {
    providers(false);
    attachFakeStore(modelWith({}));
    useUi.setState({ railCollapsed: true });
    render(<MissionControl />);
    fireEvent.click(screen.getByText("Add repository"));
    expect(useUi.getState().newProjectOpen).toBe(true);
    expect(useUi.getState().railCollapsed).toBe(false);
  });

  it("gives way to the real view once a project exists", () => {
    providers(true);
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1") },
      }),
    );
    render(<MissionControl />);
    expect(screen.queryByLabelText("Getting started")).toBeNull();
    expect(screen.getByLabelText("Project Tide")).toBeDefined();
  });
});

describe("harnessStep", () => {
  it("reads checking / error / none installed / logged out / ready", () => {
    expect(harnessStep([], true, null).state).toBe("checking");
    expect(harnessStep(NOTHING_INSTALLED, false, "offline").state).toBe("error");
    expect(harnessStep(NOTHING_INSTALLED, false, null).state).toBe("none-installed");
    expect(harnessStep([dto("pi", "Pi", true, false)], false, null)).toMatchObject({ state: "logged-out", installed: [{ id: "pi" }] });
    expect(harnessStep([dto("codex", "Codex", true, true)], false, null)).toMatchObject({ state: "ready", ready: [{ id: "codex" }] });
  });
});
