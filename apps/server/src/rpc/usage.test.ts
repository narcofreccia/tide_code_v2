import { describe, expect, it } from "vitest";
import type { RpcFrame, UsageRepairResult, UsageSummary } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { SettingsStore } from "../settings.ts";
import { FIXTURE_HOME, modelWith, OCT_19, OCT_21, thread, turn } from "../usage/testing/fixtures.ts";
import { RpcRouter } from "./router.ts";
import { DEFAULT_WINDOW_MS, registerUsageHandlers } from "./usage.ts";

const AT = Date.parse("2026-10-20T12:00:00Z");

function setup(options: { readHarnessLogs?: boolean } = {}) {
  const model = modelWith([thread("t", { provider: "codex" })], [turn("a", "t", AT, { inputTokens: 10, outputTokens: 5 }, { provider: "codex", model: "gpt-6-luna" })]);
  const engine = { getModel: () => model } as unknown as Engine;
  const settings = new SettingsStore();
  if (options.readHarnessLogs === false) settings.set({ glassBox: { readHarnessLogs: false } });
  const router = new RpcRouter();
  registerUsageHandlers(router, { engine, settings, tideHome: "/tide-home", dataDir: ":memory:", home: FIXTURE_HOME, now: () => OCT_21 });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c", (f) => frames.push(f));
  let seq = 0;
  const call = async (params: unknown): Promise<{ result?: UsageSummary; error?: { code: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, "usage.summary", params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as UsageSummary };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error("no frame");
  };
  return { call };
}

describe("rpc usage.summary", () => {
  it("defaults to the last 30 days and includes external logs", async () => {
    const { call } = setup();
    const { result } = await call({});
    expect(result?.until).toBe(OCT_21);
    expect(result?.since).toBe(OCT_21 - DEFAULT_WINDOW_MS);
    expect(result?.rows.some((r) => r.source === "tide" && r.provider === "codex")).toBe(true);
    expect(result?.rows.some((r) => r.source === "external" && r.provider === "pi")).toBe(true);
  });

  it("rejects an inverted or oversized window with invalid-params", async () => {
    const { call } = setup();
    expect((await call({ since: OCT_21, until: OCT_19 })).error?.code).toBe("invalid-params");
    expect((await call({ since: 0, until: OCT_21 })).error?.code).toBe("invalid-params");
    expect((await call({ since: -5 })).error?.code).toBe("invalid-params");
  });

  it("leaves external rows out when readHarnessLogs is off, and says so", async () => {
    const { call } = setup({ readHarnessLogs: false });
    const { result } = await call({ since: OCT_19, until: OCT_21 });
    expect(result?.rows.every((r) => r.source === "tide")).toBe(true);
    expect(result?.notes.join(" ")).toMatch(/Reading the harnesses' own logs is off/);
  });

  it("honours includeExternal: false", async () => {
    const { call } = setup();
    const { result } = await call({ since: OCT_19, until: OCT_21, includeExternal: false });
    expect(result?.rows.map((r) => r.source)).toEqual(["tide"]);
    expect(result?.notes.join(" ")).toMatch(/not requested/);
  });
});

describe("rpc usage.repair", () => {
  const MIN = 60_000;

  async function repairSetup(costStates: Map<string, number[]>) {
    const clock = { now: AT };
    const store = new EventStore(await openDatabase(":memory:"));
    const engine = new Engine({ store, now: () => clock.now });
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("project");
    const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Inflated" })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("thread");
    const threadId = created.thread.id;
    // one turn per call: start at `at`, one cost report, settle a second later
    const runTurn = async (at: number, costUsd: number): Promise<string> => {
      clock.now = at;
      const req = (await engine.dispatch({ type: "turn.request", threadId, text: "go", commandId: `c${at}` })).events.find((r) => r.event.type === "turn.requested")?.event;
      if (req?.type !== "turn.requested") throw new Error("turn");
      const turnId = req.turn.id;
      await engine.dispatch({ type: "turn.start", turnId, provider: "claude", nativeSessionId: "sess" });
      await engine.dispatch({ type: "usage.report", turnId, usage: { inputTokens: 1, outputTokens: 1, costUsd } });
      clock.now = at + 1000;
      await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
      return turnId;
    };
    const t1 = await runTurn(AT, 3);
    const t2 = await runTurn(AT + MIN, 1);
    const t3 = await runTurn(AT + 120 * MIN, 4.5); // cumulative: 4 + 0.5
    const t4 = await runTurn(AT + 240 * MIN, 9); // a reopen the transcript does not confirm
    const router = new RpcRouter();
    const asked: string[] = [];
    registerUsageHandlers(router, {
      engine,
      store,
      dataDir: ":memory:",
      home: "/nowhere",
      costStates: async (id) => {
        asked.push(id);
        return costStates.get(id);
      },
    });
    const frames: RpcFrame[] = [];
    const connection = router.connection("c", (f) => frames.push(f));
    let seq = 0;
    const call = async (params: unknown): Promise<UsageRepairResult> => {
      const id = `r${++seq}`;
      await connection.handleRequest(id, "usage.repair", params);
      const frame = frames.find((f) => f.id === id);
      if (frame && "result" in frame) return frame.result as UsageRepairResult;
      throw new Error(JSON.stringify(frame));
    };
    return { engine, threadId, turns: [t1, t2, t3, t4], call, asked };
  }

  const cost = (engine: Engine, threadId: string): number | undefined => engine.getModel().threads[threadId]?.totalCostUsd;

  it("is a dry run by default", async () => {
    const { engine, threadId, turns, call, asked } = await repairSetup(new Map([["sess", [4]]]));
    const result = await call({});
    expect(asked).toEqual(["sess"]);
    expect(result.rows.map((r) => [r.turnId, r.threadTitle, r.storedUsd, r.correctedUsd, r.evidence, r.applied])).toEqual([[turns[2], "Inflated", 4.5, 0.5, "transcript", false]]);
    expect(result).toMatchObject({ storedUsd: 4.5, correctedUsd: 0.5, appliedCount: 0 });
    expect(cost(engine, threadId)).toBe(17.5);
  });

  it("applies transcript rows, heuristic ones only when asked, and never twice", async () => {
    const { engine, threadId, turns, call } = await repairSetup(new Map());
    // no transcript: both reopens are heuristic
    expect((await call({ apply: true })).appliedCount).toBe(0);
    const applied = await call({ apply: true, includeHeuristic: true });
    expect(applied.rows.map((r) => [r.turnId, r.correctedUsd, r.evidence, r.applied])).toEqual([
      [turns[2], 0.5, "heuristic", true],
      [turns[3], 4.5, "heuristic", true],
    ]);
    expect(applied.appliedCount).toBe(2);
    expect(cost(engine, threadId)).toBeCloseTo(9, 9);
    expect(engine.getModel().turns[turns[2] as string]?.usage?.costUsd).toBeCloseTo(0.5, 9);
    const again = await call({ apply: true, includeHeuristic: true });
    expect(again.appliedCount).toBe(0);
    expect(again.rows.every((r) => r.applied)).toBe(true);
    expect(cost(engine, threadId)).toBeCloseTo(9, 9);
  });

  it("needs the event log", async () => {
    const router = new RpcRouter();
    registerUsageHandlers(router, { engine: { getModel: () => modelWith([], []) } as unknown as Engine, dataDir: ":memory:" });
    const frames: RpcFrame[] = [];
    await router.connection("c", (f) => frames.push(f)).handleRequest("1", "usage.repair", {});
    expect(frames[0] && "error" in frames[0] ? frames[0].error.code : undefined).toBe("internal");
  });
});
