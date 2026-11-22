import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelWith, OCT_19, OCT_21, thread, turn } from "../testing/fixtures.ts";
import { emptyStats } from "../types.ts";
import { conversationIdFromPath, parseAntigravityFile, scanAntigravity } from "./antigravity.ts";
import { excluder, exclusionFrom } from "./dedupe.ts";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function writeTranscript(root: string, id: string, lines: unknown[], filename = "transcript.jsonl"): Promise<string> {
  const targetDir = join(root, id, ".system_generated", "logs");
  await mkdir(targetDir, { recursive: true });
  const file = join(targetDir, filename);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

describe("antigravity log ingestion", () => {
  it("extracts conversation id from transcript paths on POSIX and Windows", () => {
    expect(conversationIdFromPath("/Users/me/.gemini/antigravity-cli/brain/conv-123/.system_generated/logs/transcript.jsonl")).toBe("conv-123");
    expect(conversationIdFromPath("C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\conv-win\\.system_generated\\logs\\transcript.jsonl")).toBe("conv-win");
    expect(conversationIdFromPath("/tmp/other.jsonl")).toBeUndefined();
  });

  it("parses PLANNER_RESPONSE token rows, ignores non-planner lines and transcript_full.jsonl, and dedupes by step", async () => {
    dir = await mkdtemp(join(tmpdir(), "tide-agy-usage-"));
    const root = join(dir, ".gemini", "antigravity-cli", "brain");
    const ts1 = new Date(OCT_19 + 60_000).toISOString();
    const ts2 = new Date(OCT_19 + 120_000).toISOString();
    const rows = [
      { step_index: 0, type: "USER_INPUT", created_at: ts1, content: "hi" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: ts1, model: "gemini-4-neon-high", input_tokens: 1000, cache_read_tokens: 500, output_tokens: 200 },
      // duplicate step_index should be ignored
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: ts1, model: "gemini-4-neon-high", input_tokens: 1000, cache_read_tokens: 500, output_tokens: 200 },
      { step_index: 2, type: "GENERIC", created_at: ts1, content: "tool output" },
      { step_index: 3, type: "PLANNER_RESPONSE", created_at: ts2, model: "gemini-4-neon-high", input_tokens: 400, cache_read_tokens: 1500, output_tokens: 300 },
    ];
    await writeTranscript(root, "conv-a", rows);
    // transcript_full.jsonl must never be read
    await writeTranscript(root, "conv-a", rows, "transcript_full.jsonl");

    const stats = emptyStats();
    const records = [];
    for await (const r of scanAntigravity({ home: dir, since: OCT_19, until: OCT_21, stats })) {
      records.push(r);
    }
    expect(stats.filesScanned).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "antigravity",
      model: "gemini-4-neon-high",
      sessionId: "conv-a",
      tokens: { in: 1000, out: 200, cacheRead: 500, cacheWrite: 0 },
    });
    expect(records[1]).toMatchObject({
      provider: "antigravity",
      model: "gemini-4-neon-high",
      sessionId: "conv-a",
      tokens: { in: 400, out: 300, cacheRead: 1500, cacheWrite: 0 },
    });
  });

  it("stops early on records past until + slack (partial)", async () => {
    const future = new Date(OCT_21 + 2 * 3600_000).toISOString();
    async function* lines() {
      yield JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: future, model: "gemini-4-neon-high", input_tokens: 10, output_tokens: 5 });
    }
    const parsed = await parseAntigravityFile(lines(), OCT_21, "/x/conv-1/.system_generated/logs/transcript.jsonl");
    expect(parsed.partial).toBe(true);
    expect(parsed.records).toEqual([]);
  });

  it("excludes Antigravity sessions already counted by Tide turns, while keeping older uncounted ones", async () => {
    dir = await mkdtemp(join(tmpdir(), "tide-agy-dedupe-"));
    const root = join(dir, ".gemini", "antigravity-cli", "brain");
    const ts = new Date(OCT_19 + 60_000).toISOString();
    await writeTranscript(root, "agy-old-uncounted", [{ step_index: 1, type: "PLANNER_RESPONSE", created_at: ts, model: "gemini-4-neon-high", input_tokens: 500, output_tokens: 100 }]);
    await writeTranscript(root, "agy-counted", [{ step_index: 1, type: "PLANNER_RESPONSE", created_at: ts, model: "gemini-4-neon-high", input_tokens: 800, output_tokens: 200 }]);

    const model = modelWith(
      [
        thread("t-old", { provider: "antigravity", nativeSessionId: "agy-old-uncounted" }),
        thread("t-new", { provider: "antigravity", nativeSessionId: "agy-counted" }),
      ],
      [
        turn("u-new", "t-new", OCT_19 + 60_000, { inputTokens: 800, outputTokens: 200 }, { provider: "antigravity" }),
      ],
    );
    const exclude = excluder(exclusionFrom(model, undefined));
    const records = [];
    for await (const r of scanAntigravity({ home: dir, since: OCT_19, until: OCT_21, exclude })) {
      records.push(r);
    }
    expect(records.map((r) => r.sessionId)).toEqual(["agy-old-uncounted"]);
  });
});
