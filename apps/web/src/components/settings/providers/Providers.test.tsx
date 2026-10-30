import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AcpRegistryAgent, UserSettings, UserSettingsPatch } from "@tide/contracts";
import { ProvidersSection } from "../ProvidersSection.tsx";
import { CODEX_WORK, PROVIDER_FIXTURE } from "../fixtures.ts";
import { mockRpc, resetUi } from "../../../testHarness.ts";
import { setProvidersForTest } from "../../../state/providers.ts";
import { defaultUserSettings, resetServerSettings, useServerSettings } from "../../../state/serverSettings.ts";
import { instanceId, parseEnv, splitArgs } from "./instances.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetServerSettings();
});

describe("instance ids and fields", () => {
  it("derives `<kind>:<slug>` without repeating the kind, unique", () => {
    expect(instanceId("codex", "Codex · work", [])).toBe("codex:work");
    expect(instanceId("codex", "Work", ["codex:work"])).toBe("codex:work-2");
    expect(instanceId("claude", "", [])).toBe("claude:account");
  });

  it("parses env lines and quoted args", () => {
    expect(parseEnv("A=1\n# note\n\nB = two=2\nbad line")).toEqual({ env: { A: "1", B: "two=2" }, invalid: ["bad line"] });
    expect(splitArgs(`-y "@x/y cli" --acp`)).toEqual(["-y", "@x/y cli", "--acp"]);
  });
});

const REGISTRY: AcpRegistryAgent[] = [
  { id: "gemini", name: "Gemini CLI", description: "Google's agent", version: "0.9.0", license: "Apache-2.0", distribution: "npx" },
  { id: "rustagent", name: "Rust Agent", distribution: "binary" },
];

function mount(settings: Partial<UserSettings> = {}) {
  setProvidersForTest(PROVIDER_FIXTURE);
  useServerSettings.setState({ settings: { ...defaultUserSettings(), ...settings }, loaded: true });
  const patches: UserSettingsPatch[] = [];
  const rpc = mockRpc({
    "settings.set": ({ patch }: { patch: UserSettingsPatch }) => {
      patches.push(patch);
      return { ...useServerSettings.getState().settings, ...(patch.providerInstances ? { providerInstances: patch.providerInstances } : {}) };
    },
    "providers.acpRegistry": () => ({ agents: REGISTRY, fetchedAt: 1 }),
    "providers.list": () => [...PROVIDER_FIXTURE],
  });
  render(<ProvidersSection />);
  return { patches, rpc };
}

describe("Settings › Providers instances", () => {
  it("adds a second account of a bundled harness", async () => {
    const { patches } = mount();
    const codex = within(screen.getByRole("article", { name: "Codex" }));
    fireEvent.click(codex.getByText("Add account"));
    fireEvent.change(screen.getByLabelText("Instance name"), { target: { value: "Codex · work" } });
    fireEvent.change(screen.getByLabelText("Home directory"), { target: { value: "~/.codex-work" } });
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "OPENAI_BASE_URL=http://x" } });
    expect(screen.getByText("id codex:work")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      providerInstances: [
        { id: "codex:work", kind: "codex", label: "Codex · work", home: "~/.codex-work", env: { OPENAI_BASE_URL: "http://x" } },
      ],
    });
  });

  it("blocks an env line that is not KEY=VALUE", () => {
    mount();
    fireEvent.click(within(screen.getByRole("article", { name: "Claude Code" })).getByText("Add account"));
    fireEvent.change(screen.getByLabelText("Instance name"), { target: { value: "Team" } });
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "oops" } });
    expect(screen.getByText("Not KEY=VALUE: oops")).toBeDefined();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds an ACP agent from the registry; others need a manual command", async () => {
    const { patches } = mount();
    fireEvent.click(screen.getByText("Add ACP agent…"));
    const rust = within(await screen.findByRole("listitem", { name: "Rust Agent" }));
    expect((rust.getByRole("button", { name: "Add Rust Agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(rust.getByText("needs a manual command")).toBeDefined();
    const gemini = within(screen.getByRole("listitem", { name: "Gemini CLI" }));
    expect(gemini.getByText("npx")).toBeDefined();
    expect(gemini.getByText("v0.9.0 · Apache-2.0")).toBeDefined();
    fireEvent.click(gemini.getByRole("button", { name: "Add Gemini CLI" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      providerInstances: [{ id: "acp:gemini", kind: "acp", label: "Gemini CLI", acpAgentId: "gemini" }],
    });
  });

  it("adds an ACP agent by command", async () => {
    const { patches } = mount();
    fireEvent.click(screen.getByText("Add ACP agent…"));
    fireEvent.click(await screen.findByText("Manual…"));
    fireEvent.change(screen.getByLabelText("Instance name"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "my-agent" } });
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "--acp --verbose" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.providerInstances).toEqual([
      { id: "acp:my-agent", kind: "acp", label: "My Agent", command: "my-agent", args: ["--acp", "--verbose"] },
    ]);
  });

  it("shows a configured instance as a card and removes it after confirming", async () => {
    const { patches } = mount({ providerInstances: [{ id: "codex:work", kind: "codex", label: "Codex · work" }] });
    setProvidersForTest([...PROVIDER_FIXTURE, CODEX_WORK]);
    const card = within(await screen.findByRole("article", { name: "Codex · work" }));
    expect(card.queryByText("Add account")).toBeNull();
    fireEvent.click(card.getByRole("button", { name: /More actions for/ }));
    fireEvent.click(screen.getByText("Remove…"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(patches).toEqual([{ providerInstances: [] }]));
  });
});
