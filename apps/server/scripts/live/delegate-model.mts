// Live check (R23): the user names a model the way its picker shows it ("Haiku 5.5") and the
// orchestrator's delegate runs on the id the target harness lists for it ("haiku"), whether the
// orchestrator took the id from its hint or the server replaced the spelling.
// Needs a scratch server (see README) and both harnesses logged in.
//   ORCH=codex DELEGATE=claude    orchestrator and delegate (defaults)
//   SPELLED="Haiku 5.5"           the model as the user names it
//   EXPECT=haiku                  the listed id the delegate must run on
//   MODE=…                        runtime mode of the orchestrator
import { readFileSync } from "node:fs";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const port = process.env.PORT ?? "3821";
const orchestrator = process.env.ORCH ?? "codex";
const delegate = process.env.DELEGATE ?? "claude";
const spelled = process.env.SPELLED ?? "Haiku 5.5";
const expected = process.env.EXPECT ?? "haiku";
const mode = process.env.MODE ?? "auto-accept-edits";
const timeoutS = Number(process.env.TIMEOUT_S ?? "300");

const token = (JSON.parse(readFileSync(`${S}/home1/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:${port}/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Turn = { threadId: string; status: string; requestedAt: number };
type Activity = { id: string; kind: string; threadId: string; status?: string; requestId?: string; toolName?: string };
type Message = { role: string; text: string };
type Thread = { id: string; provider: string; status: string; delegatedBy?: string; model?: string };
type Model = { threads: Record<string, Thread>; turns: Record<string, Turn>; activities: Record<string, Activity>; messages: Record<string, Message>; threadMessages: Record<string, string[]> };
const model = () => c.call<Model>("model.get", {});
const dispatch = (command: unknown) => c.call<{ events: any[] }>("orchestration.dispatch", { command });
const turnsOf = (m: Model, threadId: string) => Object.values(m.turns).filter((u) => u.threadId === threadId).sort((a, b) => a.requestedAt - b.requestedAt);
const lastReply = (m: Model, threadId: string) =>
  (m.threadMessages[threadId] ?? []).map((id) => m.messages[id]).filter((x): x is Message => x !== undefined && x.role === "assistant" && x.text.length > 0).at(-1)?.text ?? "";
const busy = (m: Model, threadId: string) => Object.values(m.turns).some((u) => u.threadId === threadId && (u.status === "running" || u.status === "requested" || u.status === "queued"));

let failed = false;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};

const providers = await c.call<{ id: string; installed: boolean; loggedIn: boolean; models: { id: string; label: string }[] }[]>("providers.list", {});
const target = providers.find((p) => p.id === delegate);
check(`${delegate} lists ${expected} and not the spelling "${spelled}"`, target?.models.some((x) => x.id === expected) === true && target.models.every((x) => x.id !== spelled), target?.models.map((x) => `${x.id} (${x.label})`).join(", "));

const rootPath = process.env.SMOKE ?? `${S}/smoke-fanout`;
const existing = Object.values((await c.call<{ projects: Record<string, { id: string; rootPath: string }> }>("model.get", {})).projects).find((x) => x.rootPath === rootPath);
const projectId: string = existing?.id ?? (await dispatch({ type: "project.create", title: "fan-out", rootPath })).events.find((e) => e.event.type === "project.created").event.project.id;
const t = await dispatch({ type: "thread.create", projectId, provider: orchestrator, ...(process.env.MODEL ? { model: process.env.MODEL } : {}), mode, useWorktree: false });
const parentId: string = t.events.find((e) => e.event.type === "thread.created").event.thread.id;
await dispatch({
  type: "turn.request",
  threadId: parentId,
  text: `Delegate one task to ${delegate} with tide_delegate, on the ${spelled} model, title "model-check", completion "wait", prompt: "Reply with exactly: M-DONE". Then reply with one line that quotes the delegate's final reply.`,
});

const answered = new Set<string>();
const children = (m: Model) => Object.values(m.threads).filter((x) => x.delegatedBy === parentId);
let m = await model();
let done = false;
for (let i = 0; i < timeoutS && !done; i++) {
  await sleep(1000);
  m = await model();
  // a delegate may reach for a Tide tool of its own (Codex lists threads first): its card is answered too
  const involved = new Set([parentId, ...children(m).map((x) => x.id)]);
  for (const a of Object.values(m.activities)) {
    if (a.kind !== "approval" || a.status !== "pending" || a.requestId === undefined || !involved.has(a.threadId) || answered.has(a.id)) continue;
    answered.add(a.id);
    if (/\btide\b|tide_/.test(a.toolName ?? "")) await dispatch({ type: "approval.respond", threadId: a.threadId, requestId: a.requestId, decision: "accept" });
  }
  done = children(m).length === 1 && !busy(m, parentId) && children(m).every((x) => !busy(m, x.id)) && lastReply(m, parentId).includes("M-DONE");
}

const kid = children(m)[0];
check("one delegate thread", children(m).length === 1, children(m).map((x) => `${x.provider}:${x.status}`).join(", "));
check(`the delegate's model is the listed id ${expected}`, kid?.model === expected, `thread.model = ${kid?.model}`);
if (kid !== undefined) {
  check("the delegate's turn completed", turnsOf(m, kid.id).at(-1)?.status === "completed", turnsOf(m, kid.id).map((u) => u.status).join(", "));
  check("the delegate answered", lastReply(m, kid.id).includes("M-DONE"), lastReply(m, kid.id).slice(0, 80));
}
check("the orchestrator reports the result", lastReply(m, parentId).includes("M-DONE"), lastReply(m, parentId).slice(0, 200));
check("finished inside the time limit", done, `${timeoutS} s`);
if (failed) process.exitCode = 1;
c.close();
