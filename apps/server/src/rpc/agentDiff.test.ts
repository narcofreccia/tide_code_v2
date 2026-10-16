import { afterEach, describe, expect, it } from "vitest";
import type { RpcFrame, RpcOutput } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV } from "../vcs/testing/tempRepo.ts";
import { boundFile, registerAgentDiffHandler } from "./agentDiff.ts";
import { RpcRouter } from "./router.ts";

type Diff = RpcOutput<"agent.thread.diff">;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function created(engine: Engine, command: Parameters<Engine["dispatch"]>[0]): Promise<string> {
  const event = (await engine.dispatch(command)).events[0]?.event;
  if (event?.type === "project.created") return event.project.id;
  if (event?.type === "thread.created") return event.thread.id;
  throw new Error(`unexpected ${event?.type}`);
}

async function setup() {
  const repo = await createTempRepo("tide-agent-diff-");
  const store = await openEventStore(":memory:");
  cleanups.push(() => repo.cleanup(), async () => store.close());
  const engine = new Engine({ store });
  const checkpoints = new CheckpointService({ git: (cwd) => new Git(cwd, { env: GIT_TEST_ENV }) });
  const router = new RpcRouter();
  registerAgentDiffHandler(router, { engine, checkpoints });

  await repo.write("a.txt", "one\ntwo\n");
  await repo.commit("init");
  const projectId = await created(engine, { type: "project.create", title: "Repo", rootPath: repo.dir });
  const otherProject = await created(engine, { type: "project.create", title: "Other", rootPath: `${repo.dir}-elsewhere` });
  const caller = await created(engine, { type: "thread.create", projectId, provider: "claude", title: "Reviewer" });
  const target = await created(engine, { type: "thread.create", projectId, provider: "codex", title: "Impl" });
  const foreign = await created(engine, { type: "thread.create", projectId: otherProject, provider: "codex" });
  const requested = (await engine.dispatch({ type: "turn.request", threadId: target, text: "go" })).events.at(-1)?.event;
  if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
  const before = await checkpoints.recordBefore(repo.dir, target, requested.turn.id);
  await engine.dispatch({ type: "checkpoint.record", turnId: requested.turn.id, phase: "before", ref: before.ref });

  const frames: RpcFrame[] = [];
  const connection = router.connection("agent", (frame) => frames.push(frame), { agentThreadId: caller });
  let seq = 0;
  const call = async (params: unknown): Promise<{ result?: Diff; error?: { code: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, "agent.thread.diff", params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as Diff };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error("no frame");
  };
  return { repo, call, target, foreign, beforeSha: before.sha };
}

describe("rpc agent.thread.diff", () => {
  it("returns what the thread changed since its first turn, per file, bounded", async () => {
    const s = await setup();
    await s.repo.write("a.txt", "one\nTWO\nthree\n");
    await s.repo.write("big.txt", `${"x".repeat(100)}\n`.repeat(200));
    await s.repo.writeBytes("logo.bin", Buffer.from([0, 1, 2, 0, 255]));
    const { result } = await s.call({ threadId: s.target, maxCharsPerFile: 500 });
    expect(result?.base).toBe(s.beforeSha);
    expect(result?.head).toBe("WORKTREE");
    const byPath = Object.fromEntries((result?.files ?? []).map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ status: "modified", additions: 2, deletions: 1, truncated: false });
    expect(byPath["a.txt"]?.patch).toContain("+TWO");
    expect(byPath["big.txt"]).toMatchObject({ status: "added", additions: 200, truncated: true });
    expect(byPath["big.txt"]?.patch).toHaveLength(500);
    expect(byPath["logo.bin"]).toMatchObject({ truncated: false });
    expect(byPath["logo.bin"]?.patch).toBeUndefined();
  });

  it("defaults to 8000 characters per file", async () => {
    const s = await setup();
    await s.repo.write("big.txt", `${"y".repeat(100)}\n`.repeat(200));
    const { result } = await s.call({ threadId: s.target });
    expect(result?.files[0]?.patch).toHaveLength(8000);
  });

  it("refuses threads the caller cannot reach", async () => {
    const s = await setup();
    expect((await s.call({ threadId: s.foreign })).error?.code).toBe("forbidden");
    expect((await s.call({ threadId: "nope" })).error?.code).toBe("not-found");
  });
});

describe("boundFile", () => {
  it("keeps a short patch whole and drops none from a binary file", () => {
    expect(boundFile({ path: "a", status: "added", additions: 1, deletions: 0, patch: "+a" }, 10)).toEqual({ path: "a", status: "added", additions: 1, deletions: 0, patch: "+a", truncated: false });
    expect(boundFile({ path: "b", status: "added", additions: 0, deletions: 0, binary: true }, 10)).toEqual({ path: "b", status: "added", additions: 0, deletions: 0, truncated: false });
  });
});
