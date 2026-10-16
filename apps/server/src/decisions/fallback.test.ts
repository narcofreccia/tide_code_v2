import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ProviderInstance } from "@tide/contracts";
import type { DriverRegistry } from "../provider/registry.ts";
import { SettingsStore } from "../settings.ts";
import { FALLBACK_SYSTEM, FallbackJudge, fallbackPrompt, parseFallback } from "./fallback.ts";
import { unitsOf, type JudgeCall, type JudgeQuestion } from "./judge.ts";

const label: JudgeQuestion = { kind: "label", id: "ap", site: "approvals", state: { cmd: "ls" }, instructions: "Classify the approval.", labels: { routine: "read-only", consequential: "writes" } };
const yesNo: JudgeQuestion = { kind: "yes-no", id: "d", site: "delegates", state: "z".repeat(50), instructions: "Did the delegate finish?" };
const callOf = (q: JudgeQuestion, stateTokens = 1000): JudgeCall => ({ site: q.site, state: q.kind === "per-item" ? {} : q.state, stateTokens, units: unitsOf(q) });

function rig(options: { oneShot?: boolean; complete?: (r: CompletionRequest) => Promise<CompletionResult>; fallback?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  const settings = new SettingsStore();
  if (options.fallback !== false) settings.set({ decisions: { fallback: { provider: "claude", model: "haiku" } } });
  const instance = {
    kind: "claude",
    ...(options.complete !== undefined
      ? {
          complete: (r: CompletionRequest) => {
            requests.push(r);
            return (options.complete as (r: CompletionRequest) => Promise<CompletionResult>)(r);
          },
        }
      : {}),
  } as unknown as ProviderInstance;
  const registry = {
    has: (k: string) => k === "claude",
    get: async () => instance,
    status: async () => ({ caps: { oneShot: options.oneShot ?? true } }),
  } as unknown as DriverRegistry;
  return { judge: new FallbackJudge({ registry, settings, dataDir: ":memory:", now: () => 0 }), requests };
}

const answer = (text: string, label?: string): Promise<CompletionResult> => Promise.resolve({ text, ...(label !== undefined ? { label } : {}), elapsedMs: 12, model: "haiku-x", usage: { inputTokens: 80, outputTokens: 1 } });

describe("FallbackJudge", () => {
  it("builds the classifier prompt and clips the state", () => {
    const p = fallbackPrompt(callOf(label), unitsOf(label)[0]!);
    expect(p).toBe('Classify the approval.\nLabels: routine — read-only; consequential — writes\nState:\n{"cmd":"ls"}');
    const clipped = fallbackPrompt(callOf(yesNo, 10), unitsOf(yesNo)[0]!);
    expect(clipped.endsWith(`${"z".repeat(29)}…`)).toBe(true);
    expect(clipped).toContain("Labels: yes; no");
  });

  it("parses the structured label first, else the first line, case-insensitively; yes/no map to true/false", () => {
    const [u] = unitsOf(label);
    expect(parseFallback(u!, "whatever", "routine")).toEqual({ label: "routine" });
    expect(parseFallback(u!, "\n  Consequential.\nbecause", undefined)).toEqual({ label: "consequential" });
    expect(parseFallback(u!, "maybe", undefined)).toBeUndefined();
    const [y] = unitsOf(yesNo);
    expect(parseFallback(y!, "Yes", undefined)).toEqual({ label: "true", score: 1 });
    expect(parseFallback(y!, "no", undefined)).toEqual({ label: "false", score: 0 });
  });

  it("asks the configured harness one unit at a time", async () => {
    const r = rig({ complete: () => answer("routine") });
    expect(r.judge.available()).toBe(true);
    const out = await r.judge.ask([callOf(label), callOf(yesNo)]);
    expect(out[0]).toEqual({ id: "ap", label: "routine", confidence: 1, source: "fallback", tokens: 80, elapsedMs: 12, model: "haiku-x" });
    expect(out[1]).toMatchObject({ id: "d", source: "fallback", confidence: 0, error: expect.stringContaining("unmatched") });
    expect(r.requests).toHaveLength(2);
    expect(r.requests[0]).toMatchObject({ system: FALLBACK_SYSTEM, model: "haiku", labels: ["routine", "consequential"], timeoutMs: 25_000 });
    expect(r.requests[1]?.labels).toEqual(["yes", "no"]);
  });

  it("refuses without a fallback, without complete(), or without the oneShot cap", async () => {
    expect(rig({ fallback: false }).judge.available()).toBe(false);
    expect((await rig({}).judge.ask([callOf(label)]))[0]?.error).toContain("cannot answer one-shot");
    expect((await rig({ oneShot: false, complete: () => answer("routine") }).judge.ask([callOf(label)]))[0]?.error).toContain("cannot answer one-shot");
  });

  it("a harness error becomes an error verdict; calls never overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const r = rig({
      complete: async (req) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (req.prompt.includes("delegate")) throw new Error("rate limited");
        return answer("routine");
      },
    });
    const [a, b] = await Promise.all([r.judge.ask([callOf(label)]), r.judge.ask([callOf(yesNo)])]);
    expect(a?.[0]).toMatchObject({ source: "fallback", label: "routine" });
    expect(b?.[0]).toMatchObject({ source: "fallback", error: "rate limited" });
    expect(maxActive).toBe(1);
  });
});
