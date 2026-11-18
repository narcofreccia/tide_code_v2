// Live check: one orchestrator thread hands two tasks to two harnesses at once with tide_delegate,
// the first delegate uses a sub-agent of its own, and both results come back to the orchestrator.
// Needs a scratch server (see README) and every harness named below logged in.
//   ORCH=claude DELEGATES=codex,claude   orchestrator and the two delegates (defaults)
//   WAIT=1        the orchestrator blocks in tide_delegate (completion "wait") instead of being woken
//   NOWAIT=1      the first delegate does not wait for its sub-agent: it must still count as busy until the sub-agent ends
//   MODE=…        runtime mode of the orchestrator; delegates never get a broader one
//   APPROVE_ALL=1 accept every approval card; without it only Tide's own tools are accepted
import { readFileSync } from "node:fs";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const port = process.env.PORT ?? "3821";
const orchestrator = process.env.ORCH ?? "claude";
const [first = "codex", second = "claude"] = (process.env.DELEGATES ?? "codex,claude").split(",");
const wait = process.env.WAIT === "1";
const noWait = process.env.NOWAIT === "1";
const mode = process.env.MODE ?? "auto-accept-edits";
const approveAll = process.env.APPROVE_ALL === "1";
const timeoutS = Number(process.env.TIMEOUT_S ?? "480");

const token = (JSON.parse(readFileSync(`${S}/home1/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:${port}/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Turn = { id: string; threadId: string; status: string; requestedAt: number; settledAt?: number };
type Activity = { id: string; kind: string; threadId: string; status?: string; updatedAt: number; childKey?: string; parentToolUseId?: string; requestId?: string; toolName?: string; name?: string };
type Message = { role: string; text: string; turnId: string; notification?: { source: string; summary: string } };
type Thread = { id: string; provider: string; status: string; delegatedBy?: string; title?: string };
type Model = { threads: Record<string, Thread>; turns: Record<string, Turn>; activities: Record<string, Activity>; messages: Record<string, Message>; threadMessages: Record<string, string[]> };
const model = () => c.call<Model>("model.get", {});
const dispatch = (command: unknown) => c.call<{ events: any[] }>("orchestration.dispatch", { command });
const turnsOf = (m: Model, threadId: string) => Object.values(m.turns).filter((u) => u.threadId === threadId).sort((a, b) => a.requestedAt - b.requestedAt);
const messagesOf = (m: Model, threadId: string) => (m.threadMessages[threadId] ?? []).map((id) => m.messages[id]).filter((x): x is Message => x !== undefined);
const lastReply = (m: Model, threadId: string) => messagesOf(m, threadId).filter((x) => x.role === "assistant" && x.text.length > 0).at(-1)?.text ?? "";
const busy = (m: Model, threadId: string) =>
  m.threads[threadId]?.status === "running" ||
  Object.values(m.turns).some((u) => u.threadId === threadId && (u.status === "running" || u.status === "requested" || u.status === "queued")) ||
  Object.values(m.activities).some((a) => a.threadId === threadId && a.kind === "child" && a.status === "running");

let failed = false;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};

// a second run (another orchestrator, WAIT=1) reuses the project of the first
const rootPath = process.env.SMOKE ?? `${S}/smoke-fanout`;
const existing = Object.values((await c.call<{ projects: Record<string, { id: string; rootPath: string }> }>("model.get", {})).projects).find((x) => x.rootPath === rootPath);
const projectId: string = existing?.id ?? (await dispatch({ type: "project.create", title: "fan-out", rootPath })).events.find((e) => e.event.type === "project.created").event.project.id;
const t = await dispatch({ type: "thread.create", projectId, provider: orchestrator, ...(process.env.MODEL ? { model: process.env.MODEL } : {}), mode, useWorktree: false });
const parentId: string = t.events.find((e) => e.event.type === "thread.created").event.thread.id;

const taskA = noWait
  ? "Spawn one sub-agent and have it read the file a.txt in the current directory and then run the shell command: sleep 20. Do not wait for the sub-agent. Reply at once with exactly: A-DONE spawned"
  : "Spawn one sub-agent and have it read the file a.txt in the current directory. Wait for the sub-agent to finish. Then reply with exactly: A-DONE followed by the content of the file.";
const taskB = "Reply with exactly: B-DONE";
const after = wait
  ? 'Pass completion "wait" in both calls. When both have returned, reply with one line that quotes the final reply of each delegate.'
  : "Leave completion at its default. When both calls have returned, reply with exactly: DISPATCHED and end your turn. Do not poll and do not wait. You will be told when the delegates finish: then reply with one line that quotes the final reply of each delegate.";
await dispatch({
  type: "turn.request",
  threadId: parentId,
  text: `Call the tide_delegate tool twice in this turn. Call 1: provider "${first}", title "fanout-a", prompt: "${taskA}" Call 2: provider "${second}", title "fanout-b", prompt: "${taskB}" ${after}`,
});

const answered = new Set<string>();
const children = (m: Model) => Object.values(m.threads).filter((x) => x.delegatedBy === parentId);
let m = await model();
let done = false;
for (let i = 0; i < timeoutS && !done; i++) {
  await sleep(1000);
  m = await model();
  const involved = new Set([parentId, ...children(m).map((x) => x.id)]);
  for (const a of Object.values(m.activities)) {
    if (a.kind !== "approval" || a.status !== "pending" || a.requestId === undefined || !involved.has(a.threadId) || answered.has(a.id)) continue;
    answered.add(a.id);
    // Claude names the tool (`mcp__tide__tide_delegate`), Codex the server (`mcp:tide`)
    const tide = /\btide\b|tide_/.test(a.toolName ?? "");
    console.log(`approval in ${m.threads[a.threadId]?.provider}: ${a.toolName}${a.parentToolUseId ? " (from a sub-agent)" : ""} → ${tide || approveAll ? "accepted" : "left for you (APPROVE_ALL=1 accepts it)"}`);
    if (tide || approveAll) await dispatch({ type: "approval.respond", threadId: a.threadId, requestId: a.requestId, decision: "accept" });
  }
  const reply = lastReply(m, parentId);
  done = children(m).length === 2 && [...involved].every((id) => !busy(m, id)) && reply.includes("A-DONE") && reply.includes("B-DONE");
}

const kids = children(m);
const a = kids.find((x) => x.provider === first && lastReply(m, x.id).includes("A-DONE")) ?? kids.find((x) => x.title === "fanout-a") ?? kids[0];
const b = kids.find((x) => x.id !== a?.id);
check("two delegate threads", kids.length === 2, kids.map((x) => `${x.provider}:${x.status}`).join(", "));
check(`delegates run on ${first} and ${second}`, a?.provider === first && b?.provider === second, `${a?.provider}, ${b?.provider}`);
for (const [label, kid] of [["a", a], ["b", b]] as const) {
  if (kid === undefined) continue;
  const turns = turnsOf(m, kid.id);
  check(`delegate ${label} completed and is quiet`, turns.at(-1)?.status === "completed" && !busy(m, kid.id), `${turns.map((u) => u.status).join(", ")} | reply: ${lastReply(m, kid.id).slice(0, 80)}`);
}
if (a !== undefined) {
  const rows = Object.values(m.activities).filter((x) => x.threadId === a.id);
  const agents = rows.filter((x) => x.kind === "child");
  const nested = rows.filter((x) => x.parentToolUseId !== undefined && agents.some((s) => s.childKey === x.parentToolUseId));
  check("delegate a used a sub-agent", agents.length > 0, agents.map((s) => `${s.name ?? "?"}:${s.status}`).join(", "));
  check("the sub-agent's rows nest under it", nested.length > 0, `${nested.length} nested of ${rows.length} rows`);
  check("no sub-agent left running", agents.every((s) => s.status !== "running"));
  if (noWait) {
    // the delegate's own turn ended first; it is finished for the orchestrator only once its sub-agent is
    const agentEnd = Math.max(...agents.map((s) => s.updatedAt));
    const ownEnd = turnsOf(m, a.id)[0]?.settledAt ?? Infinity;
    const wokenAt = Math.max(...messagesOf(m, parentId).filter((x) => x.notification?.source === "delegate").map((x) => m.turns[x.turnId]?.requestedAt ?? 0));
    check("the sub-agent outlived its delegate's turn", ownEnd < agentEnd, `turn settled ${ownEnd}, sub-agent ended ${agentEnd}`);
    check("the orchestrator heard of delegate a only after its sub-agent ended", wokenAt >= agentEnd, `woken ${wokenAt}, sub-agent ended ${agentEnd}`);
  }
}
const parentTurns = turnsOf(m, parentId);
const wakeUps = messagesOf(m, parentId).filter((x) => x.notification?.source === "delegate");
const lastChildSettle = Math.max(...kids.flatMap((x) => turnsOf(m, x.id).map((u) => u.settledAt ?? 0)));
if (wait) {
  check("results came through the wait, no wake-up on top", wakeUps.length === 0, `${wakeUps.length} wake-up(s)`);
} else {
  check("the orchestrator's first turn ended before the delegates did", (parentTurns[0]?.settledAt ?? Infinity) < lastChildSettle, `first turn settled ${parentTurns[0]?.settledAt}, last delegate ${lastChildSettle}`);
  check("the orchestrator was woken by the delegates", wakeUps.length >= 1 && wakeUps.length <= 2, wakeUps.map((x) => x.notification?.summary).join(" | "));
}
const final = lastReply(m, parentId);
check("the orchestrator reports both results", final.includes("A-DONE") && final.includes("B-DONE"), final.slice(0, 200));
check("finished inside the time limit", done, `${timeoutS} s`);
if (failed) process.exitCode = 1;
c.close();
