// Live check (R22): an orchestrator that was given an image shows it to a sub-agent of its own (by the
// saved path) and to a delegate on another harness (tide_delegate `images`), without describing it.
// Needs a scratch server (see README) and both harnesses logged in.
//   ORCH=claude DELEGATE=codex   orchestrator and delegate (defaults)
//   MODE=…        runtime mode of the orchestrator
//   APPROVE_ALL=1 accept every approval card; without it only Tide's own tools are accepted
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { WsTestClient } from "../../src/rpc/testing/wsClient.ts";

const S = process.env.S!;
const port = process.env.PORT ?? "3821";
const orchestrator = process.env.ORCH ?? "claude";
const delegate = process.env.DELEGATE ?? "codex";
const mode = process.env.MODE ?? "auto-accept-edits";
const approveAll = process.env.APPROVE_ALL === "1";
const timeoutS = Number(process.env.TIMEOUT_S ?? "480");
const COLOUR = "green";

/** A 64x64 png of one RGB colour. */
function solidPng(r: number, g: number, b: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const size = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([r, g, b]))]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const token = (JSON.parse(readFileSync(`${S}/home1/server.json`, "utf8")) as { token: string }).token;
const c = await WsTestClient.open(`ws://127.0.0.1:${port}/ws?token=${token}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Attachment = { mediaType: string; path?: string; inline?: boolean };
type Message = { role: string; text: string; turnId: string; attachments?: Attachment[]; notification?: unknown };
type Thread = { id: string; provider: string; status: string; delegatedBy?: string; worktreePath?: string };
type Activity = { id: string; kind: string; threadId: string; status?: string; requestId?: string; toolName?: string; parentToolUseId?: string };
type Turn = { threadId: string; status: string };
type Model = { threads: Record<string, Thread>; turns: Record<string, Turn>; activities: Record<string, Activity>; messages: Record<string, Message>; threadMessages: Record<string, string[]> };
const model = () => c.call<Model>("model.get", {});
const dispatch = (command: unknown) => c.call<{ events: any[] }>("orchestration.dispatch", { command });
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

const rootPath = process.env.SMOKE ?? `${S}/smoke-image`;
const existing = Object.values((await c.call<{ projects: Record<string, { id: string; rootPath: string }> }>("model.get", {})).projects).find((x) => x.rootPath === rootPath);
const projectId: string = existing?.id ?? (await dispatch({ type: "project.create", title: "image", rootPath })).events.find((e) => e.event.type === "project.created").event.project.id;
const t = await dispatch({ type: "thread.create", projectId, provider: orchestrator, ...(process.env.MODEL ? { model: process.env.MODEL } : {}), mode, useWorktree: false });
const parentId: string = t.events.find((e) => e.event.type === "thread.created").event.thread.id;

await dispatch({
  type: "turn.request",
  threadId: parentId,
  images: [{ mediaType: "image/png", data: solidPng(0, 200, 0) }],
  text: [
    "The attached image is a single flat colour. Two workers must each look at the image themselves: never name or describe the colour in anything you write to them.",
    "Worker 1: your own sub-agent tool. Give it the saved path of the image, ask it to open that file and reply with the colour's name in one lowercase word. Wait for it.",
    `Worker 2: call tide_delegate with provider "${delegate}", title "image-b", completion "wait", the image in \`images\`, and this prompt: "Look at the image you were given and reply with exactly: DEL- followed by the name of its colour in one lowercase word."`,
    "When both have answered, reply with exactly one line: SUB=<the sub-agent's word> DEL=<the delegate's reply>",
  ].join(" "),
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
    const tide = /\btide\b|tide_/.test(a.toolName ?? "");
    console.log(`approval in ${m.threads[a.threadId]?.provider}: ${a.toolName} → ${tide || approveAll ? "accepted" : "left for you (APPROVE_ALL=1 accepts it)"}`);
    if (tide || approveAll) await dispatch({ type: "approval.respond", threadId: a.threadId, requestId: a.requestId, decision: "accept" });
  }
  done = [...involved].every((id) => !busy(m, id)) && /SUB=.*DEL=/.test(lastReply(m, parentId));
}

const own = messagesOf(m, parentId).find((x) => x.role === "user")?.attachments?.[0];
check("the orchestrator's image has a saved path", own?.inline === true && own.path !== undefined, own?.path ?? "none");
check("the copy is in the orchestrator's checkout", own?.path !== undefined && existsSync(join(rootPath, own.path)));
const agents = Object.values(m.activities).filter((a) => a.threadId === parentId && a.kind === "child");
check("the orchestrator used a sub-agent", agents.length > 0, `${agents.length} sub-agent row(s)`);
// the orchestrator sees the pixels itself, so its SUB= word proves nothing: the sub-agent's own rows must name the file
const opened = own?.path !== undefined && Object.values(m.activities).some((a) => a.threadId === parentId && a.parentToolUseId !== undefined && JSON.stringify(a).includes(own.path!));
// Codex shows no rows for what its sub-agent opened, so there the answer is the only evidence
if (orchestrator === "claude") check("the sub-agent opened the saved copy", opened);
else console.log(`NOTE the sub-agent's rows ${opened ? "name" : "do not name"} the saved copy (only checked for a Claude orchestrator)`);

const kid = children(m)[0];
check(`one delegate on ${delegate}`, children(m).length === 1 && kid?.provider === delegate, children(m).map((x) => x.provider).join(", "));
if (kid !== undefined) {
  const first = messagesOf(m, kid.id).find((x) => x.role === "user");
  const got = first?.attachments?.[0];
  check("the delegate's first message carries the image", got?.inline === true && got.path !== undefined, got?.path ?? "none");
  const cwd = kid.worktreePath ?? rootPath;
  check("the copy is in the delegate's checkout", got?.path !== undefined && existsSync(join(cwd, got.path)), cwd);
  check("the delegate was not told the colour", first !== undefined && !first.text.toLowerCase().includes(COLOUR), first?.text.slice(0, 160));
  check("the delegate named the colour", lastReply(m, kid.id).toLowerCase().includes(`del-${COLOUR}`), lastReply(m, kid.id).slice(0, 80));
}
const final = lastReply(m, parentId);
check("the sub-agent named the colour", new RegExp(`SUB=\\W*${COLOUR}`, "i").test(final), final.slice(0, 160));
check("the orchestrator reports both", new RegExp(`DEL=.*${COLOUR}`, "i").test(final), final.slice(0, 160));
check("finished inside the time limit", done, `${timeoutS} s`);
if (failed) process.exitCode = 1;
c.close();
