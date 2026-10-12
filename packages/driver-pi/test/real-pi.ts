import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl } from "../src/rpc.ts";
import { workspaceBinary } from "../src/status.ts";
import { mockAgentDir, startMockModel, type MockModel, type MockReply } from "./mock-model.ts";

/**
 * Drives a REAL workspace `pi --mode rpc` (1.1.0) against the scripted mock model and returns
 * every stdout record it wrote, verbatim. Used by the fixture recorder and by the always-on
 * integration test. `react` sees each record and may write commands back (answer a dialog,
 * abort a run); the scenario ends when `done` says so or `agent_settled` arrives.
 */

export type PiRecord = Record<string, unknown> & { type: string };

export interface Scenario {
  replies: MockReply[];
  args?: string[];
  env?: Record<string, string>;
  /** commands written to stdin once pi is up; the first `prompt` starts the run */
  commands: Record<string, unknown>[];
  react?: (record: PiRecord, send: (command: Record<string, unknown>) => void) => void;
  /** end condition; default: the first `agent_settled` */
  done?: (record: PiRecord, all: PiRecord[]) => boolean;
  cwd?: string;
}

export interface Recording {
  records: PiRecord[];
  model: MockModel;
  stderr: string[];
}

export async function runRealPi(bridgePath: string | undefined, scenario: Scenario, timeoutMs = 60_000): Promise<Recording> {
  const binary = workspaceBinary();
  if (!binary) throw new Error("workspace pi binary not found");
  const model = await startMockModel(scenario.replies);
  const agentDir = mockAgentDir(model.baseUrl);
  const cwd = scenario.cwd ?? mkdtempSync(join(tmpdir(), "tide-pi-real-"));
  const args = ["--mode", "rpc", "--model", "mock/mock-1", ...(bridgePath ? ["-e", bridgePath] : []), ...(scenario.args ?? [])];
  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...scenario.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records: PiRecord[] = [];
  const stderr: string[] = [];
  const send = (command: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi scenario timed out; last records: ${JSON.stringify(records.slice(-3))}; stderr: ${stderr.join("\n")}`)), timeoutMs);
    const stop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    readJsonl(child.stdout, (line) => {
      let record: PiRecord;
      try {
        record = JSON.parse(line) as PiRecord;
      } catch {
        return;
      }
      records.push(record);
      scenario.react?.(record, send);
      const done = scenario.done ?? ((r: PiRecord) => r.type === "agent_settled");
      if (done(record, records)) stop();
    });
    readJsonl(child.stderr, (line) => stderr.push(line));
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) reject(new Error(`pi exited ${code}: ${stderr.join("\n")}`));
      else resolve();
    });
  });
  for (const command of scenario.commands) send(command);
  try {
    await finished;
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await model.close();
  }
  return { records, model, stderr };
}
