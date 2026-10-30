import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsError, SettingsStore } from "./settings.ts";
import { PRESET_TEAMS } from "./teams/presets.ts";

describe("SettingsStore", () => {
  it("defaults, persists a patch, never returns the api key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tide-settings-")), "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get()).toEqual({ providerDefaults: {}, worktreeByDefault: true, decisions: expect.objectContaining({ enabled: false, hasKey: false }), continueAfterRestart: false, followUpMode: "steer", limitPolicy: "manual", teams: PRESET_TEAMS, inbox: expect.any(Object), git: { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true }, providerInstances: [], environment: expect.objectContaining({ name: expect.any(String) }), glassBox: expect.any(Object), keybindings: {} });
    const next = store.set({ providerDefaults: { claude: { model: "opus", mode: "auto" } }, decisions: { enabled: true, apiKey: "sk-secret" } });
    expect(next).toEqual({ providerDefaults: { claude: { model: "opus", mode: "auto" } }, worktreeByDefault: true, decisions: expect.objectContaining({ enabled: true, hasKey: true }), continueAfterRestart: false, followUpMode: "steer", limitPolicy: "manual", teams: PRESET_TEAMS, inbox: expect.any(Object), git: { mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true }, providerInstances: [], environment: expect.objectContaining({ name: expect.any(String) }), glassBox: expect.any(Object), keybindings: {} });
    expect(JSON.stringify(next)).not.toContain("sk-secret");
    expect(store.decisionsApiKey()).toBe("sk-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).decisions.apiKey).toBe("sk-secret");
    // a fresh store reads it back; an empty key clears it
    const again = new SettingsStore({ path });
    expect(again.get().decisions).toMatchObject({ enabled: true, hasKey: true });
    expect(again.set({ decisions: { apiKey: "" } }).decisions.hasKey).toBe(false);
    expect(again.decisionsApiKey()).toBeUndefined();
  });
  it("round-trips continueAfterRestart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tide-settings-")), "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get().continueAfterRestart).toBe(false);
    expect(store.set({ continueAfterRestart: true }).continueAfterRestart).toBe(true);
    expect(new SettingsStore({ path }).get().continueAfterRestart).toBe(true);
    // an unrelated patch keeps it
    expect(store.set({ worktreeByDefault: false }).continueAfterRestart).toBe(true);
  });
  it("round-trips followUpMode and limitPolicy, defaulting unknown values", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-settings-"));
    const path = join(dir, "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get()).toMatchObject({ followUpMode: "steer", limitPolicy: "manual", teams: PRESET_TEAMS });
    expect(store.set({ followUpMode: "queue", limitPolicy: "reset" })).toMatchObject({ followUpMode: "queue", limitPolicy: "reset" });
    expect(new SettingsStore({ path }).get()).toMatchObject({ followUpMode: "queue", limitPolicy: "reset" });
    expect(store.set({ worktreeByDefault: false })).toMatchObject({ followUpMode: "queue", limitPolicy: "reset" });
    require("node:fs").writeFileSync(path, JSON.stringify({ followUpMode: "bogus", limitPolicy: 3 }));
    expect(new SettingsStore({ path }).get()).toMatchObject({ followUpMode: "steer", limitPolicy: "manual", teams: PRESET_TEAMS });
  });
  it("survives a corrupt file with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-settings-"));
    const path = join(dir, "settings.json");
    require("node:fs").writeFileSync(path, "{not json");
    const logs: string[] = [];
    const store = new SettingsStore({ path, log: (m) => logs.push(m) });
    expect(store.get().worktreeByDefault).toBe(true);
    expect(logs[0]).toContain("unreadable");
  });
  it("stores teams, falls back to the presets when empty, refuses duplicate ids", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tide-settings-")), "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get().teams).toEqual(PRESET_TEAMS);
    const team = { id: "mine", name: "Mine", stages: [{ key: "a", role: "implementer", provider: "codex" as const, worktree: "own" as const }] };
    expect(store.set({ teams: [team] }).teams).toEqual([team]);
    expect(new SettingsStore({ path }).get().teams).toEqual([team]);
    // an unrelated patch keeps them; a duplicate id is refused and changes nothing
    expect(store.set({ worktreeByDefault: false }).teams).toEqual([team]);
    expect(() => store.set({ teams: [team, team] })).toThrow(/duplicate team id mine/);
    expect(store.get().teams).toEqual([team]);
    // an empty list brings the presets back
    expect(store.set({ teams: [] }).teams).toEqual(PRESET_TEAMS);
    expect(JSON.parse(readFileSync(path, "utf8")).teams).toEqual([]);
    // a malformed stored team is dropped on load
    writeFileSync(path, JSON.stringify({ teams: [team, { id: "bad" }] }));
    expect(new SettingsStore({ path }).get().teams).toEqual([team]);
  });
  it("returns the full decisions DTO with defaults, validates the gray zone, clears the fallback with null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tide-settings-")), "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get().decisions).toEqual({
      enabled: false,
      hasKey: false,
      model: "jev-latest",
      endpoint: "https://api.typesafe.ai",
      usdPerMillionInput: 0.042,
      contextTokens: 28_000,
      grayZone: { low: 0.6, high: 0.85 },
      sites: { handoff: true, experts: true, delegates: true, approvals: true, stuck: true },
      expertsAutoAdvance: false,
    });
    const next = store.set({ decisions: { fallback: { provider: "claude", model: "haiku" }, grayZone: { low: 0.5, high: 0.9 }, sites: { approvals: false }, expertsAutoAdvance: true } });
    expect(next.decisions).toMatchObject({ fallback: { provider: "claude", model: "haiku" }, grayZone: { low: 0.5, high: 0.9 }, sites: { approvals: false, stuck: true }, expertsAutoAdvance: true });
    // persisted and read back
    expect(new SettingsStore({ path }).get().decisions).toMatchObject({ fallback: { provider: "claude", model: "haiku" }, sites: { approvals: false, handoff: true }, expertsAutoAdvance: true });
    // a partial sites patch keeps the others
    expect(store.set({ decisions: { sites: { stuck: false } } }).decisions.sites).toMatchObject({ approvals: false, stuck: false, handoff: true });
    for (const grayZone of [{ low: 0.9, high: 0.9 }, { low: -0.1, high: 0.5 }, { low: 0.2, high: 1.5 }, { low: Number.NaN, high: 0.5 }]) {
      expect(() => store.set({ decisions: { grayZone } })).toThrow(SettingsError);
    }
    expect(store.get().decisions.grayZone).toEqual({ low: 0.5, high: 0.9 });
    expect(store.set({ decisions: { fallback: null } }).decisions.fallback).toBeUndefined();
    // malformed stored values fall back to defaults
    writeFileSync(path, JSON.stringify({ decisions: { enabled: true, fallback: { provider: "gpt" }, grayZone: { low: 0.9, high: 0.1 }, sites: { stuck: "no" } } }));
    expect(new SettingsStore({ path }).get().decisions).toMatchObject({ enabled: true, grayZone: { low: 0.6, high: 0.85 }, sites: { stuck: true } });
    expect(new SettingsStore({ path }).get().decisions.fallback).toBeUndefined();
  });
});

describe("R12 git settings", () => {
  it("defaults to squash + delete branch + confirm, patches partially and drops unknown strategies on load", () => {
    const store = new SettingsStore({});
    expect(store.get().git).toEqual({ mergeStrategy: "squash", deleteBranchOnMerge: true, confirmMergeBack: true });
    expect(store.set({ git: { mergeStrategy: "rebase" } }).git).toEqual({ mergeStrategy: "rebase", deleteBranchOnMerge: true, confirmMergeBack: true });
    expect(store.set({ git: { confirmMergeBack: false } }).git).toEqual({ mergeStrategy: "rebase", deleteBranchOnMerge: true, confirmMergeBack: false });
  });
});
