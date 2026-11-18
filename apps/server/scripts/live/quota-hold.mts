// Live R20 check: a project quota holds new and queued turns at the cap and a lift releases them.
// Needs a logged-in Claude and a scratch server (see README). Uses a tiny amount cap so two
// one-line haiku turns cross it.
import { readFileSync } from "node:fs";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const port = process.env.PORT ?? "3821";
const token = (JSON.parse(readFileSync(`${S}/home1/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:${port}/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Turn = { id: string; threadId: string; status: string; requestedAt: number; usage?: { costUsd?: number } };
type Model = { projects: Record<string, any>; threads: Record<string, any>; turns: Record<string, Turn> };
const model = () => c.call<Model>("model.get", {});
const dispatch = (command: unknown) => c.call<{ events: any[] }>("orchestration.dispatch", { command });
const turnsOf = (m: Model, threadId: string) => Object.values(m.turns).filter((u) => u.threadId === threadId).sort((a, b) => a.requestedAt - b.requestedAt);

/** Waits until nothing of the thread is running or about to run (a held, queued turn does not count). */
async function idle(threadId: string): Promise<Model> {
  for (let i = 0; i < 180; i++) {
    const m = await model();
    const live = Object.values(m.turns).some((u) => u.threadId === threadId && (u.status === "running" || u.status === "requested"));
    if (!live && m.threads[threadId]?.status !== "running") return m;
    await sleep(1000);
  }
  throw new Error("still running after 180 s");
}
let failed = false;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};

// a repo no other live script used: earlier spend in the same project would count against the cap
const p = await dispatch({ type: "project.create", title: "side project", rootPath: process.env.SMOKE ?? `${S}/smoke-quota` });
const projectId = p.events.find((e) => e.event.type === "project.created").event.project.id;
const t = await dispatch({ type: "thread.create", projectId, provider: "claude", model: "haiku", mode: "auto", useWorktree: false });
const threadId = t.events.find((e) => e.event.type === "thread.created").event.thread.id;
await dispatch({ type: "quota.set", scope: "project", id: projectId, quota: { usdPerWeek: 0.004, onExceed: "hold" } });

await dispatch({ type: "turn.request", threadId, text: "Reply with exactly: ONE" });
let m = await idle(threadId);
console.log("after turn 1:", JSON.stringify(m.projects[projectId].quotaState));

// turn 2 takes the project over the cap; turn 3 is queued behind it while it runs
await dispatch({ type: "turn.request", threadId, text: "Reply with exactly: TWO" });
const third = await dispatch({ type: "turn.request", threadId, text: "Reply with exactly: THREE" });
const thirdId = third.events.find((e) => e.event.type === "turn.requested").event.turn.id;
m = await idle(threadId);
const state = m.projects[projectId].quotaState;
console.log("after turn 2:", JSON.stringify(state));
check("quota is exceeded", state?.status === "exceeded" && state.over.includes("*"));
check("queued turn is held", m.turns[thirdId]?.status === "queued" && m.threads[threadId].status === "idle", `turn ${m.turns[thirdId]?.status}, thread ${m.threads[threadId].status}`);
const refused = await c.expectError("orchestration.dispatch", { command: { type: "turn.request", threadId, text: "x" } });
check("a new send is refused", refused.code === "quota-exceeded", `${refused.code} | ${refused.message}`);

const lifted = await dispatch({ type: "quota.lift", scope: "project", id: projectId });
check("lift releases the held turn", lifted.events.some((e) => e.event.type === "turn.released" && e.event.turnId === thirdId), lifted.events.map((e) => e.event.type).join(", "));
m = await idle(threadId);
check("held turn ran after the lift", m.turns[thirdId]?.status === "completed", String(m.turns[thirdId]?.status));
console.log("turn costs:", turnsOf(m, threadId).map((u) => `$${(u.usage?.costUsd ?? 0).toFixed(6)}`).join(" "), "| final state:", JSON.stringify(m.projects[projectId].quotaState));
if (failed) process.exitCode = 1;
c.close();
