#!/usr/bin/env node
/**
 * Records raw ACP traffic from a real agent into ndjson fixtures.
 *
 *   node scripts/record.mjs --out test/fixtures/opencode-acp --repo <scratch git repo> \
 *     [--prompt "Reply with exactly: pong"] [--name simple-turn] [--model <id>] [--cancel-after <ms>] -- opencode acp
 *
 * --model calls the legacy `session/set_model` (OpenCode 1.1.x exposes models that way).
 *
 * Writes `init.ndjson` (initialize + session/new) and `<name>.ndjson` (the prompt turn).
 * Every line is one JSON-RPC message; messages the CLIENT sent carry `"_dir":"c2a"`, the rest
 * came from the agent's stdout. Permission requests are answered with the first allow option,
 * fs/* requests are served from disk inside --repo. Review before committing.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const flags = new Map();
for (let i = 0; i < (sep < 0 ? argv.length : sep); i += 2) flags.set(argv[i].slice(2), argv[i + 1]);
const [command, ...args] = sep < 0 ? ["opencode", "acp"] : argv.slice(sep + 1);
const out = resolve(flags.get("out") ?? "test/fixtures/opencode-acp");
const repo = resolve(flags.get("repo") ?? process.cwd());
const prompt = flags.get("prompt") ?? "Reply with exactly: pong";
const name = flags.get("name") ?? "simple-turn";

const child = spawn(command, args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
let current = [];
const pending = new Map();
let nextId = 0;
let buffer = "";
const scrub = (msg) => JSON.parse(JSON.stringify(msg).replaceAll(repo, "/repo"));

function send(msg) {
  current.push({ _dir: "c2a", ...scrub(msg) });
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
function answer(msg) {
  const p = msg.params ?? {};
  if (msg.method === "session/request_permission") {
    const option = (p.options ?? []).find((o) => o.kind === "allow_once") ?? p.options?.[0];
    return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
  }
  if (msg.method === "fs/read_text_file") return send({ jsonrpc: "2.0", id: msg.id, result: { content: readFileSync(p.path, "utf8") } });
  if (msg.method === "fs/write_text_file") {
    writeFileSync(p.path, p.content);
    return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}
child.stderr.on("data", (chunk) => process.stderr.write(`[agent:stderr] ${chunk}`));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[agent:non-json] ${line}\n`);
      continue;
    }
    current.push(scrub(msg));
    if (process.env.RECORD_DEBUG) process.stderr.write(`<- ${line.slice(0, 300)}\n`);
    if (msg.method && msg.id !== undefined) answer(msg);
    else if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.rej(new Error(JSON.stringify(msg.error)));
      else waiter.res(msg.result);
    }
  }
});
const timer = setTimeout(() => {
  process.stderr.write("timed out\n");
  child.kill();
  process.exit(1);
}, Number(process.env.RECORD_TIMEOUT ?? 300_000));

mkdirSync(out, { recursive: true });
const save = (file) => {
  writeFileSync(join(out, file), current.map((m) => JSON.stringify(m)).join("\n") + "\n");
  current = [];
};
const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "tide", version: "0.0.0-record" } });
const session = await request("session/new", { cwd: repo, mcpServers: [] });
save("init.ndjson");
if (flags.get("model")) await request("session/set_model", { sessionId: session.sessionId, modelId: flags.get("model") });
const turn = request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
// --cancel-after <ms>: send the `session/cancel` notification mid-turn (records cancellation)
if (flags.get("cancel-after")) setTimeout(() => send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }), Number(flags.get("cancel-after")));
const result = await turn;
save(`${name}.ndjson`);
console.log(JSON.stringify({ init, session: { ...session }, result }, null, 2));
clearTimeout(timer);
child.kill();
