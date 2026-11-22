import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityTranscriptUsage, antigravityTranscriptPath } from "../src/antigravity-usage.ts";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function writeTranscript(home: string, sessionId: string, rows: unknown[]): Promise<void> {
  const logsDir = join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, "transcript.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("AntigravityTranscriptUsage", () => {
  it("rejects unsafe session ids", () => {
    expect(antigravityTranscriptPath("/home/me", "../etc")).toBeUndefined();
    expect(antigravityTranscriptPath("/home/me", "a/b")).toBeUndefined();
    expect(antigravityTranscriptPath("/home/me", "sess-123")).toBe(
      join("/home/me", ".gemini", "antigravity-cli", "brain", "sess-123", ".system_generated", "logs", "transcript.jsonl"),
    );
  });

  it("returns per-turn token deltas and respects resume baselines", async () => {
    dir = await mkdtemp(join(tmpdir(), "tide-agy-live-"));
    const tracker = new AntigravityTranscriptUsage(dir);

    // Missing transcript is a quiet no-op
    expect(await tracker.delta("missing-session")).toBeUndefined();

    // Resumed session: step 1 happened before this process opened
    const prior = [
      { step_index: 0, type: "USER_INPUT", content: "old" },
      { step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 5000, cache_read_tokens: 0, output_tokens: 300 },
    ];
    await writeTranscript(dir, "conv-1", prior);
    await tracker.baseline("conv-1");

    // Turn 1 writes two PLANNER_RESPONSE steps (tool call + final reply)
    const afterTurn1 = [
      ...prior,
      { step_index: 3, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 1200, cache_read_tokens: 5300, output_tokens: 150 },
      { step_index: 5, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 800, cache_read_tokens: 6500, output_tokens: 250 },
    ];
    await writeTranscript(dir, "conv-1", afterTurn1);
    expect(await tracker.delta("conv-1")).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 11800,
    });

    // Calling delta again with no new steps returns undefined
    expect(await tracker.delta("conv-1")).toBeUndefined();

    // Turn 2 adds step 7
    await writeTranscript(dir, "conv-1", [
      ...afterTurn1,
      { step_index: 7, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 300, cache_read_tokens: 7300, output_tokens: 90 },
    ]);
    expect(await tracker.delta("conv-1")).toEqual({
      inputTokens: 300,
      outputTokens: 90,
      cacheReadTokens: 7300,
    });
  });
});
