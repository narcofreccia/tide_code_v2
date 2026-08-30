/**
 * Records a real `codex app-server` session to test/fixtures/<name>.ndjson (one
 * `{method, params}` notification per line — exactly what `CodexNormalizer.next` consumes)
 * so the normalizer is tested against shapes we did not invent.
 *
 *   node --experimental-strip-types scripts/record-fixture.ts [basic|plan|both]
 *
 * Requires an installed, logged-in `codex` (`codex login`). Runs in a throwaway temp dir;
 * approvals are auto-accepted. Fixtures recorded without a login capture the failure path
 * only (see test/fixtures/error-turn.ndjson).
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "../src/app-server.ts";
import { collaborationModeFor, policyFor } from "../src/modes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "test", "fixtures");

interface Scenario {
  name: string;
  prompt: string;
  plan: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  basic: { name: "basic-turn", prompt: "List the files here in one line, then say done.", plan: false },
  plan: { name: "plan-turn", prompt: "Plan how you would add a README to this directory. Do not write any files.", plan: true },
};

async function record(scenario: Scenario): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `tide-codex-${scenario.name}-`));
  writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
  mkdirSync(fixtureDir, { recursive: true });
  const out = join(fixtureDir, `${scenario.name}.ndjson`);
  writeFileSync(out, "");

  let settled: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });

  const server = await AppServer.start({
    binaryPath: "codex",
    cwd,
    env: process.env,
    log: (message) => console.error(message),
    onNotification: (method, params) => {
      appendFileSync(out, `${JSON.stringify({ method, params })}\n`);
      if (method === "turn/completed") settled?.();
    },
    onRequest: (method, params, id) => {
      console.error(`auto-accepting ${method}`);
      server.respond(id, method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "accept" });
      void params;
    },
  });

  const policy = policyFor("auto-accept-edits", [cwd]);
  const started = await server.request<{ thread: { id: string }; model: string }>("thread/start", {
    cwd,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
  });
  await server.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: scenario.prompt, text_elements: [] }],
    cwd,
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy: policy.sandboxPolicy,
    model: started.model,
    collaborationMode: collaborationModeFor(scenario.plan ? "plan" : "default", started.model),
  });

  await done;
  server.close();
  console.log(`recorded ${out} (cwd ${cwd})`);
}

const which = process.argv[2] ?? "both";
const chosen = which === "both" ? Object.values(SCENARIOS) : [SCENARIOS[which]];
for (const scenario of chosen) {
  if (!scenario) throw new Error(`unknown scenario: ${which}`);
  await record(scenario);
}
