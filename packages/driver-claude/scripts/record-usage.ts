/**
 * Records the usage/cost lifecycle of a real Claude Code session across processes, to
 * test/fixtures/usage-*.ndjson: two turns on one streaming query, the same session resumed
 * in a new process (third turn), a fork of it, and a background sub-agent whose report runs
 * as a harness turn. Also copies the transcripts' `cost-state` lines next to them.
 *
 *   node --experimental-strip-types scripts/record-usage.ts <scratch-dir> [claude-binary]
 *
 * Cheapest model, one-line prompts: about seven model turns in all.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../src/async-queue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "test", "fixtures");
const base = process.argv[2];
if (!base) throw new Error("usage: record-usage.ts <scratch-dir> [claude-binary]");
const binary = process.argv[3];
mkdirSync(base, { recursive: true });
const cwd = mkdtempSync(join(base, "usage-"));

interface Message {
  type: string;
  subtype?: string;
  session_id?: string;
}

function userMessage(text: string): Record<string, unknown> {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
}

/** One query fed `prompts` one result at a time; `extraResults` more results are awaited after the last prompt. */
async function run(name: string, prompts: string[], options: Record<string, unknown>, extraResults = 0): Promise<string> {
  const out = join(fixtureDir, `${name}.ndjson`);
  writeFileSync(out, "");
  const inbox = new AsyncQueue<Record<string, unknown>>();
  const q = query({
    prompt: inbox.drain() as AsyncIterable<never>,
    options: {
      cwd,
      model: "haiku",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      ...options,
    },
  });
  let sessionId = "";
  let results = 0;
  const total = prompts.length + extraResults;
  inbox.push(userMessage(prompts[0] ?? ""));
  for await (const raw of q) {
    const message = raw as Message;
    appendFileSync(out, `${JSON.stringify(message)}\n`);
    if (message.type === "system" && message.subtype === "init" && message.session_id) sessionId = message.session_id;
    if (message.type !== "result") continue;
    results++;
    if (results >= total) {
      inbox.close(); // a graceful end, so the CLI writes whatever it writes on exit
      continue;
    }
    const next = prompts[results];
    if (next !== undefined) inbox.push(userMessage(next));
  }
  inbox.close();
  console.log(`recorded ${out} (session ${sessionId})`);
  return sessionId;
}

function transcriptPath(sessionId: string): string | undefined {
  const root = join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function copyCostState(sessionId: string, name: string): void {
  const file = transcriptPath(sessionId);
  if (!file) {
    console.log(`no transcript for ${sessionId}`);
    return;
  }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"cost-state"'));
  writeFileSync(join(fixtureDir, `${name}.jsonl`), lines.map((line) => `${line}\n`).join(""));
  console.log(`copied ${lines.length} cost-state line(s) of ${file}`);
}

const first = await run("usage-two-turns", ["Reply with the single word one.", "Reply with the single word two."], {});
copyCostState(first, "usage-transcript-after-two");
await run("usage-resume", ["Reply with the single word three."], { resume: first });
copyCostState(first, "usage-transcript-after-resume");
const fork = await run("usage-fork", ["Reply with the single word four."], { resume: first, forkSession: true });
copyCostState(fork, "usage-transcript-fork");
const bg = await run(
  "usage-background",
  ["Launch exactly one background sub-agent with the Agent tool (run_in_background: true, model haiku) that runs `echo ready` with Bash and reports the output. Do not wait: reply with the single word launched. When it reports, reply with the single word done."],
  {},
  1,
);
copyCostState(bg, "usage-transcript-background");
