import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgePath } from "../src/bridge-path.ts";
import { runRealPi, type PiRecord, type Scenario } from "./real-pi.ts";

/**
 * Records test/fixtures/pi/*.ndjson from the REAL workspace pi (1.1.0) + tide-bridge, with the
 * scripted mock model standing in for a provider (no credentials needed or written):
 *
 *   node --experimental-strip-types test/record-fixtures.ts
 *
 * Every record is pi's own stdout, in order. The only edits: the system message's prompt
 * text (which lists the recording machine's skills and paths) is elided, and temp paths and
 * timestamps are replaced with stable placeholders.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "fixtures", "pi");
const repoRoot = join(here, "..", "..", "..");
const askExtension = join(out, "ask-extension.ts");
const echoMcp = join(out, "echo-mcp.mjs");

const modeEnv = (mode: string, interaction = "default"): Record<string, string> => ({ TIDE_RUNTIME_MODE: mode, TIDE_INTERACTION: interaction });
const prompt = (message: string): Record<string, unknown> => ({ id: "p1", type: "prompt", message });

export const SCENARIOS: Record<string, Scenario> = {
  "basic-turn": {
    replies: [{ reasoning: "The user wants a greeting.", text: "Hello from pi." }],
    env: modeEnv("auto"),
    commands: [prompt("say hello")],
  },
  "tool-call": {
    replies: [{ text: "Listing files.", toolCalls: [{ name: "bash", arguments: { command: "ls" } }] }, { text: "One file." }],
    env: modeEnv("auto"),
    commands: [prompt("list the files")],
  },
  approval: {
    replies: [{ toolCalls: [{ name: "bash", arguments: { command: "touch created.txt" } }] }, { text: "Created." }],
    env: modeEnv("approval-required"),
    commands: [prompt("create a file")],
    react: (record, send) => {
      if (record.type === "extension_ui_request" && record["method"] === "confirm") send({ type: "extension_ui_response", id: record["id"], confirmed: true });
    },
  },
  plan: {
    replies: [
      { toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] },
      { toolCalls: [{ name: "tide_propose_plan", arguments: { plan: "# Plan\n\n1. Read the code\n2. Change it" } }] },
      { text: "Plan proposed." },
    ],
    env: modeEnv("auto", "plan"),
    commands: [prompt("plan a change")],
  },
  "user-input": {
    replies: [{ toolCalls: [{ name: "ask_user", arguments: {} }] }, { text: "Thanks." }],
    args: ["-e", askExtension],
    env: modeEnv("auto"),
    commands: [prompt("ask me")],
    react: (record, send) => {
      if (record.type !== "extension_ui_request") return;
      if (record["method"] === "select") send({ type: "extension_ui_response", id: record["id"], value: "blue" });
      if (record["method"] === "input") send({ type: "extension_ui_response", id: record["id"], cancelled: true });
    },
  },
  mcp: {
    replies: [{ toolCalls: [{ name: "mcp__echo__echo", arguments: { text: "ping" } }] }, { text: "Echoed." }],
    env: { ...modeEnv("approval-required"), TIDE_MCP_SERVERS: JSON.stringify([{ name: "echo", command: process.execPath, args: [echoMcp] }]) },
    commands: [prompt("echo ping")],
  },
  "error-turn": {
    replies: [{ status: 400, error: "mock: this model refuses" }],
    env: modeEnv("auto"),
    commands: [prompt("fail please")],
  },
  aborted: {
    replies: [{ toolCalls: [{ name: "bash", arguments: { command: "sleep 30" } }] }],
    env: modeEnv("auto"),
    commands: [prompt("wait a while")],
    react: (record, send) => {
      if (record.type === "tool_execution_start") send({ id: "a1", type: "abort" });
    },
  },
  reconfigure: {
    replies: [],
    env: modeEnv("approval-required"),
    commands: [
      { id: "c1", type: "get_commands" },
      { id: "p1", type: "prompt", message: '/tide-config {"mode":"auto","plan":true}' },
      { id: "m1", type: "set_model", provider: "mock", modelId: "mock-1" },
      { id: "m2", type: "set_model", provider: "mock", modelId: "nope" },
    ],
    done: (_record, all) => ["c1", "p1", "m1", "m2"].every((id) => all.some((entry) => entry.type === "response" && entry["id"] === id)),
  },
};

/** Elides machine-specific content; everything else is byte-for-byte pi's record. */
export function sanitize(records: PiRecord[]): string {
  return records
    .map((record) => {
      let json = JSON.stringify(record, (key, value: unknown) => {
        if (key === "sections" || (key === "content" && typeof value === "string" && value.length > 2000)) return "<elided system prompt>";
        if (key === "timestamp" && typeof value === "number") return 0;
        if (key === "commands" && Array.isArray(value)) return value.filter((entry: { source?: string; sourceInfo?: { source?: string } }) => entry.sourceInfo?.source === "builtin" || entry.sourceInfo?.source === "cli");
        return value;
      });
      json = json.replace(/\/(?:private\/)?var\/folders\/[^"\\]+?\/T\/|\/tmp\//g, "/tmp/");
      json = json.split(repoRoot).join("<repo>");
      json = json.replace(/tide-pi-(agent|real)-[A-Za-z0-9]+/g, "tide-pi-$1-XXXX").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
      return json;
    })
    .join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bridge = resolveBridgePath();
  const only = process.argv.slice(2);
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const { records, stderr } = await runRealPi(bridge, scenario);
    writeFileSync(join(out, `${name}.ndjson`), `${sanitize(records)}\n`);
    console.log(`${name}: ${records.length} records${stderr.length > 0 ? ` (stderr: ${stderr.slice(0, 3).join(" | ")})` : ""}`);
  }
}
