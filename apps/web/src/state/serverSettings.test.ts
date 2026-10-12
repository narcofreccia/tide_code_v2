import { afterEach, describe, expect, it } from "vitest";
import type { UserSettings } from "@tide/contracts";
import { mockRpc, resetUi } from "../testHarness.ts";
import {
  loadServerSettings,
  patchServerSettings,
  providerDefault,
  setProviderDefault,
  useServerSettings,
  worktreeByDefault,
} from "./serverSettings.ts";
import { useToasts } from "./toast.ts";

afterEach(() => {
  resetUi();
  useToasts.setState({ toasts: [] });
});

const SERVER: UserSettings = {
  providerDefaults: { codex: { model: "gpt-5", mode: "auto" } },
  worktreeByDefault: false,
  decisions: { enabled: true, hasKey: true },
};

describe("server settings", () => {
  it("starts from defaults and adopts settings.get", async () => {
    expect(worktreeByDefault()).toBe(true);
    mockRpc({ "settings.get": () => SERVER });
    await loadServerSettings();
    expect(useServerSettings.getState().loaded).toBe(true);
    expect(worktreeByDefault()).toBe(false);
    expect(providerDefault("codex")).toEqual({ model: "gpt-5", mode: "auto" });
    expect(providerDefault("pi")).toEqual({});
  });

  it("applies a patch optimistically and keeps the server's answer", async () => {
    let resolve!: (value: UserSettings) => void;
    const rpc = mockRpc({ "settings.set": () => new Promise<UserSettings>((r) => (resolve = r)) });
    const pending = patchServerSettings({ worktreeByDefault: false });
    expect(worktreeByDefault()).toBe(false);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { worktreeByDefault: false } });
    resolve({ ...SERVER, worktreeByDefault: false });
    await pending;
    expect(useServerSettings.getState().settings.decisions.hasKey).toBe(true);
  });

  it("reverts and toasts when the server refuses", async () => {
    mockRpc({
      "settings.set": () => {
        throw new Error("disk full");
      },
    });
    await patchServerSettings({ worktreeByDefault: false });
    expect(worktreeByDefault()).toBe(true);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Saving settings failed: disk full"]);
  });

  it("sends the whole provider map so other harnesses' defaults survive", async () => {
    mockRpc({ "settings.get": () => SERVER });
    await loadServerSettings();
    const rpc = mockRpc({ "settings.set": (p: { patch: Partial<UserSettings> }) => ({ ...SERVER, ...p.patch }) });
    await setProviderDefault("claude", { model: "opus" });
    expect(rpc).toHaveBeenCalledWith("settings.set", {
      patch: { providerDefaults: { codex: { model: "gpt-5", mode: "auto" }, claude: { model: "opus" } } },
    });
    expect(providerDefault("claude")).toEqual({ model: "opus" });
  });

  it("never marks a key as set before the server says so", async () => {
    mockRpc({
      "settings.set": () => {
        throw new Error("nope");
      },
    });
    const pending = patchServerSettings({ decisions: { apiKey: "sk-1" } });
    expect(useServerSettings.getState().settings.decisions.hasKey).toBe(false);
    await pending;
    expect(JSON.stringify(useServerSettings.getState())).not.toContain("sk-1");
  });
});
