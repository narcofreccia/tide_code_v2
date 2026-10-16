import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, ProviderInstance } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { EventStore } from "../orchestration/store.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { SettingsStore } from "../settings.ts";
import { createJudgeService } from "./service.ts";

const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe("createJudgeService", () => {
  it("reads settings live: master switch, per-site toggle, gray zone and fallback; records to the ledger", async () => {
    const store = new EventStore(await openDatabase(":memory:"));
    stores.push(store);
    const settings = new SettingsStore();
    const prompts: CompletionRequest[] = [];
    const instance = { kind: "claude", complete: async (r: CompletionRequest) => (prompts.push(r), { text: "consequential", elapsedMs: 3 }) } as unknown as ProviderInstance;
    const registry = { has: () => true, get: async () => instance, status: async () => ({ caps: { oneShot: true } }) } as unknown as DriverRegistry;
    const { judge, ledger } = createJudgeService({
      settings,
      registry,
      store,
      env: {},
      dataDir: ":memory:",
      sleep: async () => undefined,
      now: () => 1000,
      transport: async () => ({ model: "jev-1.13.0", usage: { input_tokens: 50 }, answers: { q0: { type: "choice", choice: "routine", confidence: 0.8, probabilities: {} } } }),
    });
    const q = { kind: "label" as const, id: "ap", site: "approvals" as const, state: { cmd: "rm -rf build" }, instructions: "Classify", labels: { routine: "safe", consequential: "risky" } };
    expect(judge.enabled("approvals")).toBe(false);
    settings.set({ decisions: { enabled: true, apiKey: "k" } });
    expect(judge.enabled("approvals")).toBe(true);
    // 0.8 < high 0.85, no fallback configured: Jev's verdict stands
    expect((await judge.ask(q))[0]).toMatchObject({ source: "jev", label: "routine" });
    settings.set({ decisions: { fallback: { provider: "claude" } } });
    expect((await judge.ask(q))[0]).toMatchObject({ source: "fallback", label: "consequential" });
    expect(prompts).toHaveLength(1);
    settings.set({ decisions: { grayZone: { low: 0.5, high: 0.75 } } });
    expect((await judge.ask(q))[0]).toMatchObject({ source: "jev" });
    settings.set({ decisions: { sites: { approvals: false } } });
    expect(judge.enabled("approvals")).toBe(false);
    expect(ledger.statsToday(1000).today).toEqual({ jev: { calls: 3, tokens: 150, usd: expect.any(Number) }, fallback: { calls: 1, tokens: 0, usd: 0 } });
  });
});
