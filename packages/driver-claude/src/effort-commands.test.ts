import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, OpenSessionOptions } from "@tide/contracts";
import { AsyncQueue } from "./async-queue.ts";
import { instanceEnv } from "./env.ts";
import { ClaudeInstance } from "./instance.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
import { listCommands, listModels, toSlashCommands } from "./status.ts";
import type { QueryFn, QueryLike } from "./types.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

// Synthetic: shapes follow sdk.d.ts 0.3.296 `ModelInfo` / `SlashCommand`.
const sdkModels = [
  { value: "default", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku", supportsEffort: false },
];
const sdkCommands = [
  { name: "compact", description: "Compact the conversation", argumentHint: "<instructions>", builtin: true },
  { name: "review", description: "Review a PR", argumentHint: "" },
  { name: "init", description: "", argumentHint: "", builtin: true },
];

function fakeQuery(extra: Partial<QueryLike> = {}): QueryLike {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeMessage, void> {
      yield* new AsyncQueue<ClaudeMessage>().drain();
    },
    supportedModels: async () => sdkModels,
    supportedCommands: async () => sdkCommands,
    ...extra,
  };
}

describe("claude efforts", () => {
  it("maps supportedEffortLevels to ModelInfo.efforts and leaves unsupported models without any", async () => {
    const models = await listModels(() => fakeQuery(), {}, undefined, env);
    expect(models[0]?.efforts?.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.efforts).toBeUndefined();
  });

  function session(applyFlagSettings?: QueryLike["applyFlagSettings"], effort?: string) {
    const options: OpenSessionOptions = { threadId: "t", cwd: tmpdir(), mode: "approval-required", interaction: "default", mcpServers: [], ...(effort ? { effort } : {}) };
    let seen: Record<string, unknown> = {};
    const queryFn: QueryFn = ({ options: o }) => {
      seen = o ?? {};
      return fakeQuery({ ...(applyFlagSettings ? { applyFlagSettings } : {}), setPermissionMode: async () => undefined });
    };
    const s = new ClaudeSession({}, env, options, queryFn);
    return { s, seen: () => seen };
  }

  it("passes effort in the SDK options", async () => {
    const { s, seen } = session(undefined, "high");
    void s.send({ text: "x" })[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen()["effort"]).toBe("high");
    void s.close();
  });

  it("applies an effort-only change in place via applyFlagSettings, else asks for reopen", async () => {
    const calls: unknown[] = [];
    const a = session(async (settings) => void calls.push(settings));
    void a.s.send({ text: "x" })[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));
    expect(await a.s.reconfigure({ mode: "approval-required", interaction: "default", effort: "low" })).toBe("applied");
    expect(calls).toEqual([{ effortLevel: "low" }]);
    expect(await a.s.reconfigure({ mode: "approval-required", interaction: "default" })).toBe("applied");
    expect(calls[1]).toEqual({ effortLevel: null });
    void a.s.close();

    const b = session();
    void b.s.send({ text: "x" })[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 0));
    expect(await b.s.reconfigure({ mode: "approval-required", interaction: "default", effort: "max" })).toBe("reopen");
    void b.s.close();
  });
});

describe("claude commands", () => {
  it("marks Claude's own as builtin and the rest as custom", () => {
    expect(toSlashCommands(sdkCommands)).toEqual([
      { name: "compact", description: "Compact the conversation", argumentHint: "<instructions>", source: "builtin" },
      { name: "review", description: "Review a PR", source: "custom" },
      { name: "init", source: "builtin" },
    ]);
  });

  it("lists through the idle query with the session cwd and degrades to []", async () => {
    let cwd: unknown;
    const commands = await listCommands(({ options }) => ((cwd = options?.["cwd"]), fakeQuery()), { cwd: "/repo" }, env);
    expect(cwd).toBe("/repo");
    expect(commands).toHaveLength(3);
    expect(await listCommands(() => fakeQuery({ supportedCommands: async () => Promise.reject(new Error("boom")) }), {}, env)).toEqual([]);
    const instance = new ClaudeInstance({ binaryPath: "/x" }, env, () => fakeQuery());
    expect((await instance.listCommands({ cwd: "/repo" })).map((c) => c.name)).toEqual(["compact", "review", "init"]);
  });
});

describe("claude instance env", () => {
  it("merges instance.env over config.env and maps home to CLAUDE_CONFIG_DIR", () => {
    const merged = instanceEnv({ env: { A: "1", B: "1" } }, { ...env, instance: { id: "claude:work", label: "Work", home: "/h/.claude-work", env: { B: "2" } } });
    expect(merged).toEqual({ A: "1", B: "2", CLAUDE_CONFIG_DIR: "/h/.claude-work" });
  });
});
