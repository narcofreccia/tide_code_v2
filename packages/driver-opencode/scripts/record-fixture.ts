/**
 * Records a real opencode turn to test/fixtures/<name>.ndjson (one raw SSE event per line)
 * so the normalizer is tested against shapes we did not invent.
 *
 *   node --experimental-strip-types scripts/record-fixture.ts [basic|tool|plan|all]
 *
 * Requires an installed, logged-in `opencode`. Runs in a throwaway temp dir; spawns the
 * same managed server the driver uses and shuts it down afterwards.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SdkOpencodeApi } from "../src/client.ts";
import { permissionRuleset } from "../src/permissions.ts";
import { OpencodeServer } from "../src/server.ts";
import type { OpencodeEvent, WirePermission } from "../src/wire.ts";
import type { RuntimeMode, InteractionMode } from "@tide/contracts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

interface Scenario {
  name: string;
  prompt: string;
  mode: RuntimeMode;
  interaction: InteractionMode;
  agent: string;
  /** how the recorder answers permission requests */
  reply: "once" | "reject";
}

const SCENARIOS: Record<string, Scenario> = {
  basic: { name: "basic-turn", prompt: "Reply with exactly: opencode-ok", mode: "auto", interaction: "default", agent: "build", reply: "once" },
  tool: {
    name: "tool-permission",
    prompt: "Run the bash command `echo hello-from-opencode` and tell me the output. Do nothing else.",
    mode: "approval-required",
    interaction: "default",
    agent: "build",
    reply: "once",
  },
  plan: {
    name: "plan-turn",
    prompt: "Plan, in three short bullet points, how you would add a README to this directory. Do not edit anything.",
    mode: "approval-required",
    interaction: "plan",
    agent: "plan",
    reply: "reject",
  },
};

async function record(scenario: Scenario): Promise<void> {
  const env = { dataDir: tmpdir(), log: (msg: string) => console.log(msg) };
  const server = new OpencodeServer({}, env);
  const api = new SdkOpencodeApi(await server.url());
  const directory = mkdtempSync(join(tmpdir(), `tide-opencode-${scenario.name}-`));
  writeFileSync(join(directory, "hello.txt"), "hello from tide\n");

  const created = await api.createSession({ directory, title: `fixture ${scenario.name}`, permission: permissionRuleset(scenario.mode, scenario.interaction) });
  mkdirSync(fixtureDir, { recursive: true });
  const out = join(fixtureDir, `${scenario.name}.ndjson`);
  writeFileSync(out, "");

  const abort = new AbortController();
  const stream = await api.subscribe({ directory, signal: abort.signal });
  const done = (async () => {
    for await (const event of stream as AsyncIterable<OpencodeEvent>) {
      const sessionId = (event.properties as { sessionID?: string } | undefined)?.sessionID;
      if (sessionId !== undefined && sessionId !== created.id) continue;
      if (event.type === "server.connected" || event.type === "server.heartbeat") continue;
      appendFileSync(out, `${JSON.stringify(event)}\n`);
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        const permission = event.properties as unknown as WirePermission;
        await api.respondPermission({ directory, sessionId: created.id, permissionId: permission.id, reply: scenario.reply });
      }
      if (event.type === "session.idle") break;
    }
  })();

  await api.promptAsync({ directory, sessionId: created.id, agent: scenario.agent, parts: [{ type: "text", text: scenario.prompt }] });
  await done;
  abort.abort();
  await server.dispose();
  console.log(`recorded ${out} (directory ${directory})`);
}

const which = process.argv[2] ?? "all";
const chosen = which === "all" ? Object.values(SCENARIOS) : [SCENARIOS[which]];
for (const scenario of chosen) {
  if (!scenario) throw new Error(`unknown scenario: ${which}`);
  await record(scenario);
}
process.exit(0);
