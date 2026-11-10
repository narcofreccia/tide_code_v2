import { afterEach, describe, expect, it } from "vitest";
import type { UserSettings } from "@tide/contracts";
import { mockRpc, resetUi } from "../testHarness.ts";
import {
  loadServerSettings,
  patchServerSettings,
  providerDefault,
  setFollowUpDefault,
  setLimitPolicyDefault,
  setProviderDefault,
  useServerSettings,
  worktreeByDefault,
  defaultDecisionsSettings,
  defaultUserSettings,
  applyPatch,
} from "./serverSettings.ts";
import type { UserSettingsPatch } from "@tide/contracts";
import { useToasts } from "./toast.ts";

afterEach(() => {
  resetUi();
  useToasts.setState({ toasts: [] });
});

const SERVER: UserSettings = {
  providerDefaults: { codex: { model: "gpt-5", mode: "auto" } },
  worktreeByDefault: false,
  decisions: { ...defaultDecisionsSettings(), enabled: true, hasKey: true },
  continueAfterRestart: false,
  followUpMode: "queue",
  limitPolicy: "reset",
  teams: [],
  inbox: { autoSettleAfterDays: 3, autoSettleOnMerge: true, workingSection: false },
  git: { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true, pushThreadBranches: "never", syncBaseWithRemote: true, pushBaseAfterMerge: false, generateMessages: true },
  providerInstances: [],
  environment: { name: "mainbook" },
  glassBox: { limitsInStatusBar: true, readHarnessLogs: true },
  keybindings: {},
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

  it("adopts the follow-up and limit-policy defaults and patches them", async () => {
    expect(useServerSettings.getState().settings.followUpMode).toBe("steer");
    expect(useServerSettings.getState().settings.limitPolicy).toBe("manual");
    mockRpc({ "settings.get": () => SERVER });
    await loadServerSettings();
    expect(useServerSettings.getState().settings.followUpMode).toBe("queue");
    const rpc = mockRpc({ "settings.set": (p: { patch: Partial<UserSettings> }) => ({ ...SERVER, ...p.patch }) });
    await setFollowUpDefault("steer");
    await setLimitPolicyDefault("manual");
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { followUpMode: "steer" } });
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { limitPolicy: "manual" } });
    expect(useServerSettings.getState().settings.limitPolicy).toBe("manual");
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

const TEAM: UserSettings["teams"][number] = { id: "t", name: "Review", stages: [{ key: "r", role: "reviewer", provider: "claude", worktree: "own" }] };

/** A full settings value with every optional field present, so a dropped field shows up. */
const FULL: UserSettings = {
  ...SERVER,
  decisions: { ...SERVER.decisions, fallback: { provider: "claude", model: "opus" } },
  inbox: { ...SERVER.inbox, snoozeOptions: ["2h"] },
  environment: { name: "mainbook", sshHost: "me@box", lanBind: true, projectsDir: "/code" },
  keybindings: { palette: "mod+j" },
  relay: { url: "wss://relay", hasKey: true },
  textModel: { provider: "claude", model: "haiku" },
  titleInstructions: "start with the ticket id",
  teams: [],
  providerInstances: [],
};

/**
 * One patch per patchable key. Typed as a full record so a key added to `UserSettingsPatch`
 * fails to compile here until it has a case (and so a test below).
 */
const PATCH_BY_KEY: { [K in keyof Required<UserSettingsPatch>]: { patch: UserSettingsPatch; expect: Partial<UserSettings> } } = {
  providerDefaults: { patch: { providerDefaults: { pi: { model: "x" } } }, expect: { providerDefaults: { pi: { model: "x" } } } },
  worktreeByDefault: { patch: { worktreeByDefault: true }, expect: { worktreeByDefault: true } },
  decisions: {
    patch: { decisions: { enabled: false, apiKey: "sk", fallback: null, sites: { stuck: false } } },
    expect: { decisions: { ...defaultDecisionsSettings(), enabled: false, hasKey: true, sites: { ...defaultDecisionsSettings().sites, stuck: false } } },
  },
  continueAfterRestart: { patch: { continueAfterRestart: true }, expect: { continueAfterRestart: true } },
  followUpMode: { patch: { followUpMode: "steer" }, expect: { followUpMode: "steer" } },
  limitPolicy: { patch: { limitPolicy: "manual" }, expect: { limitPolicy: "manual" } },
  teams: { patch: { teams: [TEAM] }, expect: { teams: [TEAM] } },
  inbox: { patch: { inbox: { workingSection: true } }, expect: { inbox: { ...FULL.inbox, workingSection: true } } },
  git: { patch: { git: { pushBaseAfterMerge: true } }, expect: { git: { ...FULL.git, pushBaseAfterMerge: true } } },
  providerInstances: { patch: { providerInstances: [] }, expect: { providerInstances: [] } },
  environment: {
    patch: { environment: { name: "studio", sshHost: null } },
    expect: { environment: { name: "studio", lanBind: true, projectsDir: "/code" } },
  },
  glassBox: { patch: { glassBox: { readHarnessLogs: false } }, expect: { glassBox: { limitsInStatusBar: true, readHarnessLogs: false } } },
  keybindings: { patch: { keybindings: { palette: "", rail: "mod+r" } }, expect: { keybindings: { rail: "mod+r" } } },
  relay: { patch: { relay: { url: "wss://other" } }, expect: { relay: { url: "wss://other", hasKey: true } } },
  textModel: { patch: { textModel: { provider: "codex" } }, expect: { textModel: { provider: "codex" } } },
  titleInstructions: { patch: { titleInstructions: "≤ 5 words" }, expect: { titleInstructions: "≤ 5 words" } },
};

describe("applyPatch", () => {
  it("has a case for every settings field", () => {
    const fields = new Set([...Object.keys(defaultUserSettings()), ...Object.keys(FULL)]);
    for (const field of fields) expect(Object.keys(PATCH_BY_KEY), field).toContain(field);
  });

  for (const [key, { patch, expect: changed }] of Object.entries(PATCH_BY_KEY)) {
    it(`patches ${key} and leaves every other field untouched`, () => {
      const next = applyPatch(FULL, patch);
      expect(next).toEqual({ ...FULL, ...changed });
      expect(JSON.stringify(next)).not.toContain("sk\"");
    });
  }

  it("null clears the optional fields; an empty patch changes nothing", () => {
    const cleared = applyPatch(FULL, { relay: null, textModel: null, titleInstructions: null, decisions: { fallback: null }, environment: { projectsDir: null, sshHost: null } });
    expect(cleared.relay).toBeUndefined();
    expect(cleared.textModel).toBeUndefined();
    expect(cleared.titleInstructions).toBeUndefined();
    expect(cleared.decisions.fallback).toBeUndefined();
    expect(cleared.environment).toEqual({ name: "mainbook", lanBind: true });
    expect("titleInstructions" in cleared).toBe(false);
    expect(applyPatch(FULL, {})).toEqual(FULL);
  });

  it("ignores keys a caller set to undefined instead of blanking them", () => {
    const next = applyPatch(FULL, { inbox: { workingSection: undefined }, decisions: { enabled: undefined } } as unknown as UserSettingsPatch);
    expect(next).toEqual(FULL);
  });
});

describe("before settings.get answers", () => {
  it("refuses a patch with a toast and sends nothing", async () => {
    useServerSettings.setState({ loaded: false });
    const rpc = mockRpc({ "settings.set": () => SERVER });
    await patchServerSettings({ teams: [] });
    expect(rpc).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Settings are still loading"]);
  });

  it("records a failed load until a later one answers", async () => {
    useServerSettings.setState({ loaded: false });
    mockRpc({
      "settings.get": () => {
        throw new Error("timeout");
      },
    });
    await expect(loadServerSettings()).rejects.toThrow("timeout");
    expect(useServerSettings.getState().error).toBe("timeout");
    mockRpc({ "settings.get": () => SERVER });
    await loadServerSettings();
    expect(useServerSettings.getState()).toMatchObject({ loaded: true, error: undefined });
  });
});
