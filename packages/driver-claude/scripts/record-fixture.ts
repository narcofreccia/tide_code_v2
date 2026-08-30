/**
 * Records a real Claude Code session to test/fixtures/<name>.ndjson (one raw SDKMessage per
 * line) so the normalizer can be tested against shapes we did not invent.
 *
 *   node --experimental-strip-types scripts/record-fixture.ts [basic|plan|both]
 *
 * Requires an installed, logged-in `claude`. Runs in a throwaway temp dir.
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "test", "fixtures");

interface Scenario {
  name: string;
  prompt: string;
  permissionMode: "acceptEdits" | "plan";
}

const SCENARIOS: Record<string, Scenario> = {
  basic: { name: "basic-turn", prompt: "List the files here in one line.", permissionMode: "acceptEdits" },
  plan: { name: "plan-turn", prompt: "Plan how you would add a README to this directory. Then call ExitPlanMode with your plan.", permissionMode: "plan" },
};

async function record(scenario: Scenario): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `tide-claude-${scenario.name}-`));
  writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
  mkdirSync(fixtureDir, { recursive: true });
  const out = join(fixtureDir, `${scenario.name}.ndjson`);
  writeFileSync(out, "");

  const q = query({
    prompt: scenario.prompt,
    options: {
      cwd,
      permissionMode: scenario.permissionMode,
      includePartialMessages: true,
      canUseTool: async (toolName, input) => {
        if (toolName === "ExitPlanMode") return { behavior: "deny", message: "Plan recorded in Tide." };
        if (toolName === "AskUserQuestion") {
          const questions = (input as { questions: { question: string; options: { label: string }[] }[] }).questions;
          const answers: Record<string, string> = {};
          for (const question of questions) answers[question.question] = question.options[0]?.label ?? "";
          return { behavior: "allow", updatedInput: { ...input, answers } };
        }
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  for await (const message of q) appendFileSync(out, `${JSON.stringify(message)}\n`);
  console.log(`recorded ${out} (cwd ${cwd})`);
}

const which = process.argv[2] ?? "both";
const chosen = which === "both" ? Object.values(SCENARIOS) : [SCENARIOS[which]];
for (const scenario of chosen) {
  if (!scenario) throw new Error(`unknown scenario: ${which}`);
  await record(scenario);
}
