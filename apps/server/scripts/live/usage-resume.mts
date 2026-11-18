// Live R20 check: a Claude thread's cost and tokens stay per-turn deltas across a server restart.
//   node … usage-resume.mts first    → two turns, state saved to $S/usage-resume.json
//   (restart the server on the same TIDE_HOME)
//   node … usage-resume.mts second   → a third turn on the resumed session; its cost must be
//                                      this turn's own, not the session's running total
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const port = process.env.PORT ?? "3821";
const phase = process.argv[2] ?? "first";
const statePath = `${S}/usage-resume.json`;
const token = (JSON.parse(readFileSync(`${S}/home1/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:${port}/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
type Model = { threads: Record<string, any>; turns: Record<string, { id: string; threadId: string; status: string; requestedAt: number; usage?: Usage }>; limits?: Record<string, Record<string, any>> };
const model = () => c.call<Model>("model.get", {});
const dispatch = (command: unknown) => c.call<{ events: any[] }>("orchestration.dispatch", { command });

async function turn(threadId: string, text: string): Promise<Model> {
  await dispatch({ type: "turn.request", threadId, text });
  for (let i = 0; i < 180; i++) {
    const m = await model();
    const live = Object.values(m.turns).some((u) => u.threadId === threadId && (u.status === "running" || u.status === "requested" || u.status === "queued"));
    if (!live && m.threads[threadId]?.status !== "running") return m;
    await sleep(1000);
  }
  throw new Error("turn still running after 180 s");
}
const turnsOf = (m: Model, threadId: string) => Object.values(m.turns).filter((u) => u.threadId === threadId).sort((a, b) => a.requestedAt - b.requestedAt);
const show = (label: string, u: Usage | undefined) => console.log(label, u ? `cost $${(u.costUsd ?? NaN).toFixed(6)} in ${u.inputTokens} out ${u.outputTokens} cacheRead ${u.cacheReadTokens ?? 0} cacheWrite ${u.cacheWriteTokens ?? 0}` : "no usage");

if (phase === "first") {
  const p = await dispatch({ type: "project.create", title: "usage", rootPath: `${S}/smoke` });
  const projectId = p.events.find((e) => e.event.type === "project.created").event.project.id;
  const t = await dispatch({ type: "thread.create", projectId, provider: "claude", model: "haiku", mode: "auto", useWorktree: false });
  const threadId = t.events.find((e) => e.event.type === "thread.created").event.thread.id;
  await turn(threadId, "Reply with exactly: ONE");
  const m = await turn(threadId, "Reply with exactly: TWO");
  const turns = turnsOf(m, threadId);
  show("turn 1", turns[0]?.usage);
  show("turn 2", turns[1]?.usage);
  console.log("thread total $", m.threads[threadId].totalCostUsd?.toFixed(6), "session", m.threads[threadId].nativeSessionId);
  console.log("gauges", JSON.stringify(m.limits ?? {}));
  writeFileSync(statePath, JSON.stringify({ projectId, threadId, total: m.threads[threadId].totalCostUsd, turn2: turns[1]?.usage?.costUsd }));
} else {
  if (!existsSync(statePath)) throw new Error("run the first phase before the second");
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { projectId: string; threadId: string; total: number; turn2: number };
  const m = await turn(saved.threadId, "Reply with exactly: THREE");
  const turns = turnsOf(m, saved.threadId);
  const third = turns[2]?.usage;
  show("turn 3 (after restart)", third);
  const total = m.threads[saved.threadId].totalCostUsd as number;
  console.log("thread total before $", saved.total.toFixed(6), "after $", total.toFixed(6));
  // the bug re-reported the running total: turn 3 would then cost at least everything before it
  const inflated = third?.costUsd !== undefined && third.costUsd >= saved.total;
  console.log(inflated ? "FAIL: turn 3 carries the session's running total" : "OK: turn 3 is its own delta");
  if (inflated) process.exitCode = 1;
}
c.close();
