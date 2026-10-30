import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../state/environments.ts", async () => (await import("../fleet/testEnvironments.ts")).fakeEnvironmentsModule());

import * as envs from "../../state/environments.ts";
import { makeInfo, twoMachines } from "../fleet/testEnvironments.ts";
import { closeAddMachine } from "../fleet/fleetUi.ts";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { EnvironmentsSection } from "./EnvironmentsSection.tsx";

beforeEach(() => {
  envs.useEnvironments.setState(twoMachines());
  attachFakeStore(modelWith({}));
});

afterEach(() => {
  cleanup();
  resetUi();
  closeAddMachine();
  resetServerSettings();
  vi.clearAllMocks();
});

const rpc = (extra: Record<string, (params: never) => unknown> = {}) =>
  mockRpc({
    "server.info": () => makeInfo("env-a", "laptop", { remote: { host: "0.0.0.0", port: 3777, lanUrls: ["http://192.168.1.10:3777"] } }),
    // the server answers with the settings it stored: here, the optimistic copy
    "settings.set": () => useServerSettings.getState().settings,
    ...extra,
  });

describe("Settings › Environments", () => {
  it("shows this machine and a card per other machine with its status", () => {
    rpc();
    render(<EnvironmentsSection />);

    const self = screen.getByRole("region", { name: "This machine" });
    expect((within(self).getByLabelText("Machine name") as HTMLInputElement).value).toBe("laptop");
    expect(self.textContent).toContain("laptop.local · macOS arm64 · 10 cores");
    expect(self.textContent).toContain("claude 2.1.0");

    const box = screen.getByLabelText("Machine box");
    expect(box.textContent).toContain("Connected via LAN");
    expect(within(box).getByText("Open in browser").getAttribute("href")).toBe("http://192.168.1.20:3777");

    const nas = screen.getByLabelText("Machine nas");
    expect(nas.textContent).toContain("Not paired");
    expect(nas.textContent).toContain("401 token refused");
    // the primary is "This machine", never a card
    expect(screen.queryByLabelText("Machine laptop")).toBeNull();
  });

  it("makes another machine primary and forgets one after confirming", () => {
    rpc();
    render(<EnvironmentsSection />);
    fireEvent.click(within(screen.getByLabelText("Machine box")).getByText("Make primary"));
    expect(envs.setPrimaryEnvironment).toHaveBeenCalledWith("env-b");

    fireEvent.click(within(screen.getByLabelText("Machine box")).getByText("Forget…"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Forget box?" })).getByText("Forget"));
    expect(envs.removeEnvironment).toHaveBeenCalledWith("env-b");
  });

  it("reorders routes and saves them with renumbered priorities", () => {
    rpc();
    envs.useEnvironments.setState((s) => ({
      environments: s.environments.map((e) =>
        e.id === "env-b" ? { ...e, routes: [...e.routes, { kind: "tailscale" as const, url: "ws://100.100.1.2:3777/ws", priority: 1 }] } : e,
      ),
    }));
    render(<EnvironmentsSection />);
    const box = screen.getByLabelText("Machine box");
    fireEvent.click(within(box).getByText("Routes · 2"));
    fireEvent.click(within(box).getByLabelText("Move route 2 up"));
    expect(envs.updateEnvironment).toHaveBeenCalledWith("env-b", {
      routes: [
        { kind: "tailscale", url: "ws://100.100.1.2:3777/ws", priority: 0 },
        { kind: "lan", url: "ws://192.168.1.20:3777/ws", priority: 1 },
      ],
    });
  });

  it("asks for a pairing code and shows it with the URLs", async () => {
    const caller = rpc({ "env.pairingCode": () => ({ code: "482913", expiresAt: Date.now() + 300_000, urls: ["http://192.168.1.10:3777"] }) });
    render(<EnvironmentsSection />);
    fireEvent.click(screen.getAllByText("Pair another device")[1] as HTMLElement);
    expect(await screen.findByTestId("pairing-code")).toHaveProperty("textContent", "482913");
    expect(caller.mock.calls.some(([method]) => method === "env.pairingCode")).toBe(true);
    expect(screen.getByText(/Expires in [45]:\d\d/)).toBeDefined();
    expect(within(screen.getByLabelText("Pairing URLs")).getByText("http://192.168.1.10:3777")).toBeDefined();
  });

  it("pairs a machine with a URL and a 6-digit code", async () => {
    rpc();
    render(<EnvironmentsSection />);
    fireEvent.click(screen.getByText("Add machine"));
    const sheet = screen.getByRole("dialog", { name: "Add machine" });
    fireEvent.change(within(sheet).getByLabelText("Machine URL"), { target: { value: "192.168.1.40:3777" } });
    expect(within(sheet).getByText("The code has 6 digits")).toBeDefined();
    fireEvent.change(within(sheet).getByLabelText("Pairing code"), { target: { value: "12 34 56" } });
    fireEvent.click(within(sheet).getByText("Pair"));
    await waitFor(() => expect(envs.pairWithCode).toHaveBeenCalledWith("http://192.168.1.40:3777", "123456"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull());
  });

  it("adds a machine with a token on the Token tab", async () => {
    rpc();
    render(<EnvironmentsSection />);
    fireEvent.click(screen.getByText("Add machine"));
    const sheet = screen.getByRole("dialog", { name: "Add machine" });
    fireEvent.click(within(sheet).getByRole("radio", { name: "Token" }));
    fireEvent.change(within(sheet).getByLabelText("Machine URL"), { target: { value: "https://box.tail1234.ts.net" } });
    fireEvent.change(within(sheet).getByLabelText("Machine token"), { target: { value: "tok" } });
    fireEvent.click(within(sheet).getByText("Add machine"));
    await waitFor(() =>
      expect(envs.addEnvironment).toHaveBeenCalledWith({
        routes: [{ kind: "tailscale", url: "wss://box.tail1234.ts.net/ws", priority: 0 }],
        token: "tok",
      }),
    );
  });

  it("opens Pair again prefilled for a machine that refused its token", () => {
    rpc();
    render(<EnvironmentsSection />);
    fireEvent.click(within(screen.getByLabelText("Machine nas")).getByText("Pair again"));
    const sheet = screen.getByRole("dialog", { name: "Add machine" });
    expect((within(sheet).getByLabelText("Machine URL") as HTMLInputElement).value).toBe("http://192.168.1.30:3777");
  });

  it("saves the name and SSH host through settings.set", () => {
    const caller = rpc();
    render(<EnvironmentsSection />);
    const name = screen.getByLabelText("Machine name");
    fireEvent.change(name, { target: { value: "studio" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(caller).toHaveBeenCalledWith("settings.set", { patch: { environment: { name: "studio" } } });

    const ssh = screen.getByLabelText("SSH host");
    fireEvent.change(ssh, { target: { value: "me@studio" } });
    fireEvent.blur(ssh);
    expect(caller).toHaveBeenCalledWith("settings.set", { patch: { environment: { sshHost: "me@studio" } } });
  });

  it("keeps the relay folded, then connects and disconnects it", async () => {
    const caller = rpc();
    render(<EnvironmentsSection />);
    expect(screen.queryByLabelText("Relay URL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Relay/ }));
    expect(screen.getByText(/only carries bytes/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Relay URL"), { target: { value: "wss://relay.example.com" } });
    fireEvent.change(screen.getByLabelText("Relay key"), { target: { value: "k" } });
    fireEvent.click(screen.getByText("Connect"));
    expect(caller).toHaveBeenCalledWith("settings.set", { patch: { relay: { url: "wss://relay.example.com", key: "k" } } });
    fireEvent.click(await screen.findByText("Disconnect"));
    expect(caller).toHaveBeenCalledWith("settings.set", { patch: { relay: null } });
  });
});
