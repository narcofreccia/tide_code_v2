import { describe, expect, it } from "vitest";
import { localDay } from "./buckets.ts";
import { scanExternal } from "./external.ts";
import { exclusionFrom } from "./ingest/dedupe.ts";
import { summarize } from "./summary.ts";
import { FIXTURE_HOME, modelWith, OCT_19, OCT_21, OCT_31, thread, turn } from "./testing/fixtures.ts";

const AT = Date.parse("2026-10-20T12:00:00Z");
const M = 1_000_000;

function tideModel() {
  return modelWith(
    [thread("tc", { provider: "claude", model: "claude-opus-5-5", nativeSessionId: "sess-tide" }), thread("tx", { provider: "codex", model: "gpt-6-luna" })],
    [
      turn("c1", "tc", AT, { inputTokens: M, outputTokens: 0, costUsd: 4 }, { provider: "claude", model: "claude-opus-5-5" }),
      turn("c2", "tc", AT + 1, { inputTokens: 0, outputTokens: M, cacheReadTokens: 10, costUsd: 20 }, { provider: "claude", model: "claude-opus-5-5" }),
      // codex counts cached input inside inputTokens and never reports a cost
      turn("x1", "tx", AT, { inputTokens: 3 * M, outputTokens: M, cacheReadTokens: 2 * M }, { provider: "codex", model: "gpt-6-luna" }),
      turn("old", "tc", OCT_19 - 1, { inputTokens: 5, outputTokens: 5, costUsd: 1 }, { provider: "claude", model: "claude-opus-5-5" }),
      turn("nousage", "tc", AT, undefined),
    ],
  );
}

describe("usage summary", () => {
  it("groups Tide turns by provider + instance + model with the reported cost summed", () => {
    const s = summarize({ model: tideModel(), since: OCT_19, until: OCT_21 });
    const claude = s.rows.find((r) => r.provider === "claude");
    expect(claude).toMatchObject({ source: "tide", model: "claude-opus-5-5", inputTokens: M, outputTokens: M, cacheReadTokens: 10, turns: 2, costUsd: 24 });
    expect(claude?.estimatedUsd).toBeCloseTo(24, 4);
    expect(s.pricingVersion).toBe("2026-10");
  });

  it("leaves costUsd out for Codex, estimates it, and says so", () => {
    const s = summarize({ model: tideModel(), since: OCT_19, until: OCT_21 });
    const codex = s.rows.find((r) => r.provider === "codex");
    expect(codex?.costUsd).toBeUndefined();
    // uncached input = 3M - 2M cached
    expect(codex).toMatchObject({ inputTokens: M, cacheReadTokens: 2 * M, outputTokens: M });
    expect(codex?.estimatedUsd).toBeCloseTo(1.25 + 10 + 0.25);
    expect(s.notes).toContain("Codex did not report a cost for these calls; shown as an estimate.");
  });

  it("drops costUsd when only some turns of a group reported one", () => {
    const m = modelWith(
      [thread("t", { provider: "pi" })],
      [turn("a", "t", AT, { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, { provider: "pi", model: "m" }), turn("b", "t", AT, { inputTokens: 1, outputTokens: 1 }, { provider: "pi", model: "m" })],
    );
    const s = summarize({ model: m, since: OCT_19, until: OCT_21 });
    expect(s.rows[0]?.costUsd).toBeUndefined();
    expect(s.rows[0]?.estimatedUsd).toBeUndefined();
    expect(s.notes.join(" ")).toMatch(/Some Pi calls reported no cost/);
    expect(s.notes.join(" ")).toMatch(/No price for m/);
  });

  it("buckets days in local time with tokens, complete cost and estimate", () => {
    const s = summarize({ model: tideModel(), since: OCT_19, until: OCT_21 });
    expect(s.days).toHaveLength(1);
    const day = s.days[0];
    expect(day?.day).toBe(localDay(AT));
    expect(day?.tokens).toBe(M + M + 10 + 3 * M - 2 * M + 2 * M + M);
    expect(day?.costUsd).toBeUndefined(); // the codex turns that day reported none
    expect(day?.estimatedUsd).toBeCloseTo(24 + 11.5, 3);
  });

  it("respects the window bounds, including turns at the edges", () => {
    const m = tideModel();
    expect(summarize({ model: m, since: AT, until: AT + 1 }).rows.reduce((a, r) => a + r.turns, 0)).toBe(3);
    expect(summarize({ model: m, since: AT + 2, until: OCT_31 }).rows).toEqual([]);
  });

  it("adds external rows grouped by provider + model, with Tide's own sessions left out", async () => {
    const model = tideModel();
    const external = await scanExternal({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21, exclusion: exclusionFrom(model, "/tide-home") });
    const s = summarize({ model, since: OCT_19, until: OCT_21, external });
    const ext = s.rows.filter((r) => r.source === "external");
    const opus = ext.find((r) => r.provider === "claude" && r.model === "claude-opus-5-5");
    // msg_1 only: sess-tide (thread tc) and the worktree call are Tide's
    expect(opus).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 1000 });
    expect(opus?.costUsd).toBeUndefined();
    expect(opus?.providerId).toBeUndefined();
    const pi = ext.find((r) => r.provider === "pi");
    expect(pi?.costUsd).toBeCloseTo(0.009);
    expect(s.notes.join("\n")).toMatch(/Claude Code: 3 log files read, 3 model calls, 2 from Tide's own sessions left out/);
    expect(s.notes.join("\n")).toMatch(/Claude did not report a cost for these calls; shown as an estimate/);
    expect(s.notes.join("\n")).toMatch(/No local logs in this window for OpenCode/);
  });

  it("passes the reason external logs are absent through to the notes", () => {
    const s = summarize({ model: tideModel(), since: OCT_19, until: OCT_21, externalNote: "logs off" });
    expect(s.notes).toContain("logs off");
    expect(s.rows.every((r) => r.source === "tide")).toBe(true);
  });
});
