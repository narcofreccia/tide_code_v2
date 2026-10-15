import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEnv, ProviderDriver } from "@tide/contracts";
import { claudeDriver, type ClaudeConfig, type QueryFn } from "@tide/driver-claude";
import { codexDriver, type CodexConfig } from "@tide/driver-codex";
import { opencodeDriver, type OpencodeConfig } from "@tide/driver-opencode";
import { createPiInstance, type PiConfig, type SpawnLike as PiSpawnLike } from "@tide/driver-pi";
import { recordFetch, replayFetch, type ReplayFetch } from "./http.ts";
import type { Recorder } from "./recorder.ts";
import { replayQuery, recordQuery, type ReplayQueryFn } from "./sdk.ts";
import { recordSpawn, replaySpawn, type ReplaySpawn } from "./stdio.ts";
import type { Replay } from "./transport.ts";

/**
 * The REAL drivers with only their transport swapped. Everything above the seam — session
 * logic, normalisers, approval brokers, status probing — is the production code.
 *
 * `binaryPath` points at the node binary so each driver's "is the CLI installed" check passes
 * without a real harness on the machine; the CLI itself is never executed except for its
 * `--version` probe, which then answers with node's.
 */

type CodexSpawn = NonNullable<CodexConfig["spawnImpl"]>;

const BINARY = process.execPath;
const PI_BRIDGE = "/replay/tide-bridge.js";

export interface ReplayDriver<Config, Transport> {
  driver: ProviderDriver<Config>;
  replay: Replay;
  transport: Transport;
}

function wrap<Config>(kind: ProviderDriver<Config>["kind"], override: (config: Config, env: DriverEnv) => Promise<ReturnType<ProviderDriver<Config>["create"]> extends Promise<infer P> ? P : never>): ProviderDriver<Config> {
  return { kind, defaultConfig: () => ({}) as Config, create: override };
}

export function replayCodexDriver(replay: Replay, config: Partial<CodexConfig> = {}): ReplayDriver<CodexConfig, ReplaySpawn> {
  const spawn = replaySpawn(replay);
  const driver = wrap<CodexConfig>("codex", (base, env) =>
    codexDriver.create({ binaryPath: BINARY, networkAccess: false, tomlReader: () => undefined, ...base, ...config, spawnImpl: spawn as unknown as CodexSpawn }, env),
  );
  return { driver, replay, transport: spawn };
}

export function replayPiDriver(replay: Replay, config: Partial<PiConfig> = {}): ReplayDriver<PiConfig, ReplaySpawn> {
  const spawn = replaySpawn(replay);
  const driver = wrap<PiConfig>("pi", async (base, env) =>
    createPiInstance({ binaryPath: BINARY, ...base, ...config }, env, {
      spawn: spawn as unknown as PiSpawnLike,
      fetch: async () => ({ ok: false, json: async () => undefined }),
      bridgePath: PI_BRIDGE,
      probe: async () => replay.start.version,
    }),
  );
  return { driver, replay, transport: spawn };
}

/** `serverUrl` is set so the driver neither looks for the shared service nor spawns a server. */
export function replayOpencodeDriver(replay: Replay, config: Partial<OpencodeConfig> = {}): ReplayDriver<OpencodeConfig, ReplayFetch> {
  const transport = replayFetch(replay);
  const driver = wrap<OpencodeConfig>("opencode", (base, env) =>
    opencodeDriver.create({ binaryPath: BINARY, serverUrl: "http://replay.opencode", ...base, ...config, fetchImpl: transport.fetch }, env),
  );
  return { driver, replay, transport };
}

export function replayClaudeDriver(replay: Replay, config: Partial<ClaudeConfig> = {}): ReplayDriver<ClaudeConfig, ReplayQueryFn> {
  const query = replayQuery(replay);
  const driver = wrap<ClaudeConfig>("claude", (base, env) => claudeDriver.create({ binaryPath: BINARY, ...base, ...config, queryImpl: query as unknown as QueryFn }, env));
  return { driver, replay, transport: query };
}

// ---- recording variants: the same real drivers over their real transport, tapped ----

export function recordCodexDriver(recorder: Recorder, config: Partial<CodexConfig> = {}): ProviderDriver<CodexConfig> {
  return wrap<CodexConfig>("codex", (base, env) => codexDriver.create({ ...base, ...config, spawnImpl: tappedSpawn(recorder) as unknown as CodexSpawn }, env));
}

function tappedSpawn(recorder: Recorder) {
  return recordSpawn((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => nodeSpawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }), recorder);
}

export function recordPiDriver(recorder: Recorder, config: Partial<PiConfig> = {}): ProviderDriver<PiConfig> {
  return wrap<PiConfig>("pi", async (base, env) =>
    createPiInstance({ ...base, ...config }, env, { spawn: tappedSpawn(recorder) as unknown as PiSpawnLike }),
  );
}

export function recordOpencodeDriver(recorder: Recorder, config: Partial<OpencodeConfig> = {}): ProviderDriver<OpencodeConfig> {
  return wrap<OpencodeConfig>("opencode", (base, env) =>
    opencodeDriver.create({ ...base, ...config, fetchImpl: recordFetch((input, init) => fetch(input, init), recorder) }, env),
  );
}

export function recordClaudeDriver(recorder: Recorder, config: Partial<ClaudeConfig> = {}): ProviderDriver<ClaudeConfig> {
  return wrap<ClaudeConfig>("claude", async (base, env) => {
    const module: unknown = await import("@anthropic-ai/claude-agent-sdk");
    const { query } = module as { query: (params: unknown) => never };
    const recorded = recordQuery(query as never, recorder);
    return claudeDriver.create({ ...base, ...config, queryImpl: recorded as unknown as QueryFn }, env);
  });
}

/**
 * Pi's status check reads `~/.pi/agent/auth.json` and provider API keys from the environment,
 * and a logged-in machine then spawns an extra `pi` to list models. Replay transcripts must not
 * depend on the machine, so tests call this first: HOME points at an empty directory and every
 * credential-looking variable is dropped. Returns the function that restores the environment.
 */
export function isolatePiLogin(): () => void {
  const saved = { ...process.env };
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "tide-replay-home-"));
  for (const key of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|OAUTH|_TOKEN$/i.test(key)) delete process.env[key];
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}
