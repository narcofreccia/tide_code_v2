// Live T1 check: a Claude thread, one turn, /clear-style fresh turn → new native session id, boundary in the timeline.
import { readFileSync } from "node:fs";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const home = `${S}/home1`;
const token = (JSON.parse(readFileSync(`${home}/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:3821/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Model = { threads: Record<string, any>; turns: Record<string, any>; threadTimeline: Record<string, { kind: string; id: string }[]> };
const model = () => c.call<Model>("model.get", {});
async function waitIdle(threadId: string, label: string): Promise<Model> {
  for (let i = 0; i < 120; i++) {
    const m = await model();
    const t = m.threads[threadId];
    if (t && t.status !== "running" && t.status !== "requested" && !Object.values(m.turns).some((u: any) => u.threadId === threadId && (u.status === "running" || u.status === "requested"))) return m;
    await sleep(1000);
  }
  throw new Error(`${label}: still running after 120 s`);
}

const p = await c.call<{ events: any[] }>("orchestration.dispatch", { command: { type: "project.create", title: "smoke", rootPath: `${S}/smoke` } });
const projectId = p.events.find((e) => e.event.type === "project.created").event.project.id;
console.log("project", projectId, "repo:", JSON.stringify(p.events.find((e) => e.event.type === "project.created").event.project.repo ?? null));
const t = await c.call<{ events: any[] }>("orchestration.dispatch", { command: { type: "thread.create", projectId, provider: "claude", model: "haiku", mode: "auto", useWorktree: false } });
const threadId = t.events.find((e) => e.event.type === "thread.created").event.thread.id;
console.log("thread", threadId);

await c.call("orchestration.dispatch", { command: { type: "turn.request", threadId, text: "Reply with exactly: ONE. Remember the word PARROT." } });
let m = await waitIdle(threadId, "turn 1");
const sid1 = m.threads[threadId].nativeSessionId;
console.log("turn1 session", sid1, "status", m.threads[threadId].status);

// a fresh turn while idle
const r = await c.call<{ events: any[] }>("orchestration.dispatch", { command: { type: "turn.request", threadId, text: "What word did I ask you to remember? If you have no memory of it, reply exactly: NO MEMORY.", freshSession: true } });
console.log("fresh dispatch events:", r.events.map((e) => e.event.type).join(", "));
m = await waitIdle(threadId, "turn 2");
const sid2 = m.threads[threadId].nativeSessionId;
console.log("turn2 session", sid2, "changed:", sid1 !== sid2);
const tl = m.threadTimeline[threadId].map((e) => e.kind);
console.log("timeline kinds:", tl.join(" "));
const turns = Object.values(m.turns).filter((u: any) => u.threadId === threadId).sort((a: any, b: any) => a.requestedAt - b.requestedAt);
console.log("turn2.freshSession:", turns[1]?.freshSession, "boundary turn:", m.threads[threadId].sessionBoundaryTurnId === turns[1]?.id);
const msgs = await c.call<any>("model.get", {});
const last = Object.values<any>(msgs.messages).filter((x) => x.threadId === threadId && x.role === "assistant").sort((a, b) => a.createdAt - b.createdAt).map((x) => x.text.trim());
console.log("assistant replies:", JSON.stringify(last));

// fresh while running must be refused
await c.call("orchestration.dispatch", { command: { type: "turn.request", threadId, text: "Count slowly to 3, one number per line." } });
const err = await c.expectError("orchestration.dispatch", { command: { type: "turn.request", threadId, text: "x", freshSession: true } });
console.log("fresh while running →", err.code, "|", err.message);
await waitIdle(threadId, "turn 3");
c.close();
