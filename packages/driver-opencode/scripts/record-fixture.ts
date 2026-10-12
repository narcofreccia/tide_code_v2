/**
 * Records a real OpenCode 2 turn to test/fixtures/<name>.ndjson (one raw SSE event per line,
 * only events naming the recorded session) so the normalizer is tested against shapes we did
 * not invent.
 *
 *   node --experimental-strip-types scripts/record-fixture.ts [basic|tool|plan|question|all]
 *
 * Env: OPENCODE_BIN (a 2.x binary; default: detected), OPENCODE_MODEL (`provider/model`,
 * default `opencode/big-pickle`, a free Zen model that needs no login). Spawns a private
 * `opencode serve` (never the shared service) in a throwaway directory; point XDG_* at a
 * scratch dir to keep the recording out of your real OpenCode state.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InteractionMode, RuntimeMode } from "@tide/contracts";
import { HttpOpencodeApi } from "../src/client.ts";
import { eventSessionId } from "../src/hub.ts";
import { parseModelId } from "../src/instance.ts";
import { sessionRuleset } from "../src/permissions.ts";
import { OpencodeServer } from "../src/server.ts";
import type { FormValue, OpencodeEvent, WireForm } from "../src/wire.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

interface Scenario {
  name: string;
  prompt: string;
  mode: RuntimeMode;
  interaction: InteractionMode;
  agent: string;
}

const SCENARIOS: Record<string, Scenario> = {
  basic: { name: "basic-turn", prompt: "Reply with exactly: opencode-ok", mode: "auto", interaction: "default", agent: "build" },
  tool: {
    name: "tool-permission",
    prompt: "Run the shell command `echo hello-from-opencode` and tell me the output. Do nothing else.",
    mode: "approval-required",
    interaction: "default",
    agent: "build",
  },
  plan: {
    name: "plan-turn",
    prompt: "Plan, in three short bullet points, how you would add a README to this directory. Do not edit anything.",
    mode: "approval-required",
    interaction: "plan",
    agent: "plan",
  },
  question: {
    name: "question-turn",
    prompt: "Before doing anything, use your question tool to ask me whether I prefer tabs or spaces (options: tabs, spaces). Then reply with my answer only.",
    mode: "auto",
    interaction: "default",
    agent: "build",
  },
};

async function record(server: OpencodeServer, scenario: Scenario): Promise<void> {
  const api = new HttpOpencodeApi(await server.endpoint());
  const directory = mkdtempSync(join(tmpdir(), `tide-opencode-${scenario.name}-`));
  writeFileSync(join(directory, "hello.txt"), "hello from tide\n");
  const model = parseModelId(process.env["OPENCODE_MODEL"] ?? "opencode/big-pickle");
  const session = await api.createSession({
    directory,
    title: `fixture ${scenario.name}`,
    agent: scenario.agent,
    ...(model ? { model } : {}),
    permissions: sessionRuleset(scenario.mode, scenario.interaction, directory),
  });
  mkdirSync(fixtureDir, { recursive: true });
  const out = join(fixtureDir, `${scenario.name}.ndjson`);
  writeFileSync(out, "");

  const abort = new AbortController();
  const stream = await api.subscribe({ signal: abort.signal });
  const done = (async () => {
    for await (const event of stream as AsyncIterable<OpencodeEvent>) {
      if (eventSessionId(event) !== session.id) continue;
      appendFileSync(out, `${JSON.stringify(event)}\n`);
      const data = (event as { data?: Record<string, unknown> }).data ?? {};
      if (event.type === "permission.asked") await api.replyPermission({ sessionId: session.id, requestId: data["id"] as string, decision: "once" });
      if (event.type === "form.created") {
        const form = data["form"] as WireForm;
        const answer: Record<string, FormValue> = {};
        for (const field of form.fields) answer[field.key] = field.type === "multiselect" ? [field.options?.[0]?.value ?? ""] : (field.options?.[0]?.value ?? "tabs");
        await api.replyForm({ sessionId: session.id, formId: form.id, answer });
      }
      if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started") break;
    }
  })();
  await api.prompt({ sessionId: session.id, text: scenario.prompt });
  await done;
  abort.abort();
  console.log(`recorded ${out} (session ${session.id}, directory ${directory})`);
}

const env = { dataDir: tmpdir(), log: (msg: string) => console.log(msg) };
const binary = process.env["OPENCODE_BIN"];
const server = new OpencodeServer({ attach: "standalone", ...(binary ? { binaryPath: binary } : {}) }, env);
const which = process.argv[2] ?? "all";
const chosen = which === "all" ? Object.values(SCENARIOS) : [SCENARIOS[which]];
try {
  for (const scenario of chosen) {
    if (!scenario) throw new Error(`unknown scenario: ${which}`);
    await record(server, scenario);
  }
} finally {
  await server.dispose();
}
process.exit(0);
