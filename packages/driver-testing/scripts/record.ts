/**
 * Records a transcript from a REAL harness. Needs the CLI installed and logged in.
 *
 *   pnpm --filter @tide/driver-testing record -- <provider> <scenario> [options]
 *
 *   <provider>        claude | codex | opencode | pi
 *   <scenario>        file name: apps/server/test/fixtures/replay/<provider>/<scenario>.ndjson
 *   --prompt <text>   one turn per flag, run in order (default: a one-line hello)
 *   --approve         accept approval cards (default: decline them)
 *   --steer <text>    send this as a steer on the first assistant output of the first turn
 *   --rollback <n>    after the turns, roll back the last n turns (no file restore)
 *   --mode <mode>     runtime mode: approval-required (default) | auto-accept-edits | full-access
 *   --out <dir>       fixtures root (default apps/server/test/fixtures/replay)
 *
 * It boots the same server stack the replay tests use, with the real driver's transport tapped
 * by a Recorder, drives the turns through the engine, and writes the ndjson. Review the file
 * before committing: values under secret-looking keys are masked, but prompts, paths and model
 * output are recorded as they were.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderDriver, ProviderKind, ReadModel } from "@tide/contracts";
import { createApp } from "../../../apps/server/src/app.ts";
import { Recorder } from "../src/recorder.ts";
import { recordClaudeDriver, recordCodexDriver, recordOpencodeDriver, recordPiDriver } from "../src/drivers.ts";

const BINARIES: Record<string, string> = { claude: "claude", codex: "codex", opencode: "opencode", pi: "pi" };

function parseArgs(argv: string[]): { provider: ProviderKind; scenario: string; prompts: string[]; approve: boolean; steer?: string; rollback?: number; mode: "approval-required" | "auto-accept-edits" | "full-access"; out: string } {
  const positional: string[] = [];
  const prompts: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "approve") flags.set(name, true);
    else if (name === "prompt") prompts.push(argv[++i] ?? "");
    else flags.set(name, argv[++i] ?? "");
  }
  const [provider, scenario] = positional;
  if (!provider || !scenario || !(provider in BINARIES)) throw new Error("usage: record <claude|codex|opencode|pi> <scenario> [--prompt text]... [--approve] [--steer text] [--rollback n] [--mode m] [--out dir]");
  const mode = (flags.get("mode") as string | undefined) ?? "approval-required";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return {
    provider: provider as ProviderKind,
    scenario,
    prompts: prompts.length > 0 ? prompts : ["Reply with exactly: ok"],
    approve: flags.get("approve") === true,
    ...(typeof flags.get("steer") === "string" ? { steer: flags.get("steer") as string } : {}),
    ...(typeof flags.get("rollback") === "string" ? { rollback: Number(flags.get("rollback")) } : {}),
    mode: mode as "approval-required",
    out: (flags.get("out") as string | undefined) ?? join(root, "apps", "server", "test", "fixtures", "replay"),
  };
}

function cliVersion(provider: string): string {
  try {
    const text = execFileSync(BINARIES[provider]!, ["--version"], { encoding: "utf8" });
    return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? "unknown";
  } catch {
    throw new Error(`\`${BINARIES[provider]} --version\` failed: the CLI must be installed to record`);
  }
}

const args = parseArgs(process.argv.slice(2));
const recorder = new Recorder({ provider: args.provider, version: cliVersion(args.provider), scenario: args.scenario, recordedAt: new Date().toISOString() });
const drivers: Record<string, () => ProviderDriver<never>> = {
  claude: () => recordClaudeDriver(recorder) as unknown as ProviderDriver<never>,
  codex: () => recordCodexDriver(recorder) as unknown as ProviderDriver<never>,
  opencode: () => recordOpencodeDriver(recorder) as unknown as ProviderDriver<never>,
  pi: () => recordPiDriver(recorder) as unknown as ProviderDriver<never>,
};

const tideHome = mkdtempSync(join(tmpdir(), "tide-record-home-"));
const repo = mkdtempSync(join(tmpdir(), "tide-record-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repo });

const app = await createApp({
  config: { tideHome, dataDir: ":memory:", dbPath: ":memory:", environmentId: "env-record", token: "t", host: "127.0.0.1", port: 0, dev: true, printToken: false, corsOrigins: [], version: "0.0.0-record", providers: {} },
  listen: false,
  log: (message) => console.error(message),
  registerDrivers: (registry) => registry.register(drivers[args.provider]!() as unknown as ProviderDriver<Record<string, unknown>>),
});

try {
  const model = (): ReadModel => app.engine.getModel();
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolveWait) => {
      if (done()) return resolveWait();
      const off = app.engine.subscribe(() => {
        if (!done()) return;
        off();
        resolveWait();
      });
    });

  const project = (await app.engine.dispatch({ type: "project.create", title: "record", rootPath: repo })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const thread = (await app.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: args.provider, mode: args.mode })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread.created");
  const threadId = thread.thread.id;

  // answer approvals as they appear
  const answered = new Set<string>();
  app.engine.subscribe((record) => {
    const event = record.event;
    if (event.type !== "activity.upserted" || event.activity.kind !== "approval" || event.activity.status !== "pending" || answered.has(event.activity.requestId)) return;
    answered.add(event.activity.requestId);
    void app.engine.dispatch({ type: "approval.respond", threadId, requestId: event.activity.requestId, decision: args.approve ? "accept" : "decline" });
  });

  const turnIds: string[] = [];
  for (const [index, text] of args.prompts.entries()) {
    const requested = (await app.engine.dispatch({ type: "turn.request", threadId, text })).events.map((r) => r.event).find((e) => e.type === "turn.requested");
    if (requested?.type !== "turn.requested") throw new Error("expected turn.requested");
    turnIds.push(requested.turn.id);
    if (index === 0 && args.steer !== undefined) {
      await until(() => (model().threadMessages[threadId] ?? []).some((id) => model().messages[id]?.role === "assistant"));
      await app.engine.dispatch({ type: "turn.steer", threadId, text: args.steer });
    }
    await until(() => ["completed", "interrupted", "error"].includes(model().turns[requested.turn.id]?.status ?? ""));
  }
  await app.reactor.drain();

  if (args.rollback !== undefined && args.rollback > 0) {
    const target = turnIds[turnIds.length - args.rollback];
    if (target === undefined) throw new Error(`cannot roll back ${args.rollback} of ${turnIds.length} turns`);
    await app.engine.dispatch({ type: "thread.rollback", threadId, turnId: target, restoreFiles: false });
    await app.rollback.drain();
  }

  const file = join(args.out, args.provider, `${args.scenario}.ndjson`);
  recorder.save(file);
  console.error(`recorded ${recorder.frames.length} frames to ${file}`);
} finally {
  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(tideHome, { recursive: true, force: true });
}
