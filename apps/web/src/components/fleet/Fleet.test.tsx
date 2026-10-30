import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScheduledTask } from "@tide/contracts";

vi.mock("../../state/environments.ts", async () => (await import("./testEnvironments.ts")).fakeEnvironmentsModule());

const dispatchSpy = vi.fn(async (..._args: unknown[]) => ({ seq: 1, events: [] }));
vi.mock("../../state/model.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/model.ts")>()),
  dispatch: (...args: unknown[]) => dispatchSpy(...args),
}));

const launched: string[] = [];
vi.mock("../../lib/openInEditor.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/openInEditor.ts")>()),
  launchEditorUrl: (url: string) => launched.push(url),
}));

import * as envs from "../../state/environments.ts";
import { attachFakeStore, chooseOption, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { buildPaletteItems } from "../../lib/paletteItems.ts";
import { headerMenu } from "../thread/headerMenu.ts";
import { AddProjectForm } from "../shell/AddProjectForm.tsx";
import { TaskDialog } from "../settings/TaskDialog.tsx";
import { MachinesStrip } from "./MachinesStrip.tsx";
import { useFleetUi, closeAddMachine } from "./fleetUi.ts";
import { makeInfo, twoMachines } from "./testEnvironments.ts";
import { relayHookUrl } from "./WebhookUrls.tsx";

const fake = envs as unknown as ReturnType<typeof import("./testEnvironments.ts").fakeEnvironmentsModule>;

beforeEach(() => {
  envs.useEnvironments.setState(twoMachines());
});

afterEach(() => {
  cleanup();
  resetUi();
  closeAddMachine();
  vi.clearAllMocks();
  launched.length = 0;
  for (const key of Object.keys(fake.projectEnvs)) delete fake.projectEnvs[key];
  for (const key of Object.keys(fake.threadEnvs)) delete fake.threadEnvs[key];
});

describe("Machines strip", () => {
  it("shows one chip per machine with status and load, and opens Settings › Environments", () => {
    attachFakeStore(modelWith({}));
    render(<MachinesStrip />);
    const strip = screen.getByRole("region", { name: "Machines" });
    const chips = within(strip).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
      "laptop: Connected via this computer",
      "box: Connected via LAN",
      "nas: Not paired — the token was refused",
    ]);
    expect(within(chips[1] as HTMLElement).getByText("2 busy")).toBeDefined();
    expect(within(chips[1] as HTMLElement).getByLabelText("CPU load")).toHaveProperty("value", 0.25);
    expect(within(chips[1] as HTMLElement).getByLabelText("Memory in use")).toHaveProperty("value", 0.75);

    fireEvent.click(chips[1] as HTMLElement);
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("environments");
  });

  it("is absent while no machine is known", () => {
    envs.useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
    render(<MachinesStrip />);
    expect(screen.queryByRole("region", { name: "Machines" })).toBeNull();
  });
});

describe("Run on <machine>", () => {
  it("creates the project on the chosen machine and browses that machine's disk", async () => {
    attachFakeStore(modelWith({}));
    const caller = mockRpc({ "fs.browse": () => ({ path: "/", dirs: [], recent: [] }) });
    render(<AddProjectForm onDone={() => undefined} />);
    chooseOption("Run on", /box/);
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(dispatchSpy).toHaveBeenCalledWith({ type: "project.create", title: "app", rootPath: "/srv/app" }, { envId: "env-b" }),
    );
    fireEvent.click(screen.getByText("Browse…"));
    await waitFor(() => expect(caller).toHaveBeenCalled());
  });

  it("is hidden with a single connected machine and goes to the primary", async () => {
    envs.useEnvironments.setState((s) => ({ statuses: { "env-a": s.statuses["env-a"] ?? { connection: "connected" } } }));
    attachFakeStore(modelWith({}));
    render(<AddProjectForm onDone={() => undefined} />);
    expect(screen.queryByRole("combobox", { name: "Run on" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/srv/app" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "project.create" }), { envId: "env-a" }));
  });
});

describe("Open in VS Code / Cursor", () => {
  it("opens a local worktree directly and a remote one over SSH", () => {
    const thread = makeThread("t1", { worktreePath: "/wt/t1" });
    const remote = makeThread("t2", { worktreePath: "/home/dev/wt/t2" });
    const model = modelWith({ threads: { t1: thread, t2: remote } });
    attachFakeStore(model);
    fake.threadEnvs.t1 = "env-a";
    fake.threadEnvs.t2 = "env-b";

    headerMenu(model, thread).find((i) => i.label === "Open in VS Code")?.onSelect?.();
    expect(launched).toEqual(["vscode://file/wt/t1"]);

    const blocked = headerMenu(model, remote).find((i) => i.label === "Open in Cursor");
    expect(blocked).toMatchObject({ disabled: true });
    expect(blocked?.hint).toMatch(/SSH host/);

    envs.useEnvironments.setState((s) => ({ environments: s.environments.map((e) => (e.id === "env-b" ? { ...e, sshHost: "dev@box" } : e)) }));
    headerMenu(model, remote).find((i) => i.label === "Open in Cursor")?.onSelect?.();
    expect(launched[1]).toBe("cursor://vscode-remote/ssh-remote+dev@box/home/dev/wt/t2");
  });
});

describe("Palette", () => {
  it("offers to switch the primary to another connected machine and to pair one", () => {
    const model = modelWith({});
    const items = buildPaletteItems({ model, selectedThreadId: null });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Switch primary environment: box");
    expect(labels).not.toContain("Switch primary environment: nas");
    expect(labels).not.toContain("Switch primary environment: laptop");

    items.find((i) => i.label === "Switch primary environment: box")?.run();
    expect(envs.setPrimaryEnvironment).toHaveBeenCalledWith("env-b");

    items.find((i) => i.label === "Pair a machine…")?.run();
    expect(useUi.getState().settingsSection).toBe("environments");
    expect(useFleetUi.getState().addMachine).toEqual({});
  });
});

describe("Webhook automations", () => {
  const task: ScheduledTask = {
    id: "k1",
    projectId: "p1",
    title: "On deploy",
    prompt: "check the deploy",
    schedule: { kind: "webhook", hookId: "abcdef1234567890", secret: "s3" },
    enabled: true,
    runs: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  it("shows the full URL on the project's machine, copies it and keeps the secret", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    fake.projectEnvs.p1 = "env-b";
    envs.useEnvironments.setState((s) => ({
      statuses: {
        ...s.statuses,
        "env-b": { connection: "connected", route: { kind: "lan", url: "ws://192.168.1.20:3777/ws", priority: 0 }, info: makeInfo("env-b", "box", { relay: { url: "wss://relay.example", connected: true, clientUrl: "wss://relay.example/m/env-b/ws" } }) },
      },
    }));
    const onSubmit = vi.fn();
    render(<TaskDialog task={task} threads={[]} projectId="p1" onSubmit={onSubmit} onCancel={() => undefined} />);

    const urls = screen.getByLabelText("Webhook URLs");
    expect(urls.textContent).toContain("POST http://192.168.1.20:3777/hook/abcdef1234567890");
    expect(urls.textContent).toContain("POST https://relay.example/m/env-b/hook/abcdef1234567890");
    fireEvent.click(screen.getByRole("button", { name: "Copy direct webhook URL" }));
    expect(writeText).toHaveBeenCalledWith("http://192.168.1.20:3777/hook/abcdef1234567890");

    expect((screen.getByLabelText("Webhook secret") as HTMLInputElement).value).toBe("s3");
    fireEvent.change(screen.getByLabelText("Webhook secret"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSubmit.mock.calls[0]?.[0].schedule).toEqual({ kind: "webhook", hookId: "abcdef1234567890" });
  });

  it("builds the relay variant from the relay's client URL", () => {
    expect(relayHookUrl("wss://relay.example/m/abc/ws", "h1h1h1h1")).toBe("https://relay.example/m/abc/hook/h1h1h1h1");
    expect(relayHookUrl("https://relay.example", "h1h1h1h1")).toBe("https://relay.example/hook/h1h1h1h1");
  });
});
