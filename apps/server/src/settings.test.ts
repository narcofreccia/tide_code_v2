import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "./settings.ts";

describe("SettingsStore", () => {
  it("defaults, persists a patch, never returns the api key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tide-settings-")), "settings.json");
    const store = new SettingsStore({ path });
    expect(store.get()).toEqual({ providerDefaults: {}, worktreeByDefault: true, decisions: { enabled: false, hasKey: false } });
    const next = store.set({ providerDefaults: { claude: { model: "opus", mode: "auto" } }, decisions: { enabled: true, apiKey: "sk-secret" } });
    expect(next).toEqual({ providerDefaults: { claude: { model: "opus", mode: "auto" } }, worktreeByDefault: true, decisions: { enabled: true, hasKey: true } });
    expect(JSON.stringify(next)).not.toContain("sk-secret");
    expect(store.decisionsApiKey()).toBe("sk-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).decisions.apiKey).toBe("sk-secret");
    // a fresh store reads it back; an empty key clears it
    const again = new SettingsStore({ path });
    expect(again.get().decisions).toEqual({ enabled: true, hasKey: true });
    expect(again.set({ decisions: { apiKey: "" } }).decisions.hasKey).toBe(false);
    expect(again.decisionsApiKey()).toBeUndefined();
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
});
