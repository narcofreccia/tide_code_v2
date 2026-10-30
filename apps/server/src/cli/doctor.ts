import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { readRuntime, tideHomeOf } from "./runtime.ts";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorProbes {
  /** first line of `<bin> <args>` output, or undefined when it is not installed / fails */
  version(bin: string, args: string[]): Promise<string | undefined>;
  onPath(bin: string): boolean;
  /** "free" | "tide" (a Tide server answers /health) | "busy" */
  port(port: number): Promise<"free" | "tide" | "busy">;
  runtime: { name: string; version: string };
  tideHome: string;
}

const MIN_NODE = [22, 13] as const;
const HARNESSES = [
  { bin: "claude", label: "Claude Code", install: "npm i -g @anthropic-ai/claude-code" },
  { bin: "codex", label: "Codex", install: "npm i -g @openai/codex" },
  { bin: "opencode", label: "OpenCode", install: "npm i -g @opencode/cli" },
  { bin: "pi", label: "Pi", install: "npm i -g @earendil-works/pi-coding-agent" },
];

function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function checkTideHome(home: string): Check {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = join(home, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { name: "TIDE_HOME", level: "ok", detail: `${home} is writable` };
  } catch (err) {
    return { name: "TIDE_HOME", level: "fail", detail: `${home} is not writable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkServerJson(home: string): Check {
  const file = join(home, "server.json");
  if (!existsSync(file)) return { name: "server.json", level: "ok", detail: "not created yet (the first start creates it)" };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof raw["environmentId"] !== "string" || typeof raw["token"] !== "string") return { name: "server.json", level: "fail", detail: `${file} lacks environmentId or token` };
    return { name: "server.json", level: "ok", detail: `env ${raw["environmentId"]}` };
  } catch {
    return { name: "server.json", level: "fail", detail: `${file} is not valid JSON` };
  }
}

/** Every check, in print order. Pure over the probes so tests need no real host. */
export async function runChecks(probes: DoctorProbes, port: number): Promise<Check[]> {
  const checks: Check[] = [];
  const rt = probes.runtime;
  if (rt.name === "node") checks.push({ name: "node", level: nodeOk(rt.version) ? "ok" : "fail", detail: `${rt.version}${nodeOk(rt.version) ? "" : ` (needs ≥ ${MIN_NODE.join(".")})`}` });
  else checks.push({ name: rt.name, level: "ok", detail: `${rt.version} (compiled binary)` });
  for (const tool of [
    { bin: "git", level: "fail" as const, why: "worktrees and checkpoints need git" },
    { bin: "gh", level: "warn" as const, why: "PRs from the Changes tab need the GitHub CLI" },
    { bin: "rg", level: "warn" as const, why: "workspace search falls back to a slower scan" },
  ]) {
    const v = probes.onPath(tool.bin) ? await probes.version(tool.bin, ["--version"]) : undefined;
    checks.push({ name: tool.bin, level: v !== undefined ? "ok" : tool.level, detail: v ?? `not found — ${tool.why}` });
  }
  let anyHarness = false;
  for (const h of HARNESSES) {
    const v = probes.onPath(h.bin) ? await probes.version(h.bin, ["--version"]) : undefined;
    if (v !== undefined) anyHarness = true;
    checks.push({ name: h.bin, level: v !== undefined ? "ok" : "warn", detail: v ?? `${h.label} not installed (${h.install})` });
  }
  if (!anyHarness) checks.push({ name: "harnesses", level: "fail", detail: "no harness CLI found; install at least one" });
  checks.push(checkTideHome(probes.tideHome));
  checks.push(checkServerJson(probes.tideHome));
  const state = await probes.port(port);
  checks.push({
    name: `port ${port}`,
    level: state === "busy" ? "fail" : "ok",
    detail: state === "free" ? "free" : state === "tide" ? "a Tide server is already running there" : "in use by another program (pass --port)",
  });
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const tag: Record<CheckLevel, string> = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `[${tag[c.level]}] ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}

function onPath(bin: string): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return (process.env["PATH"] ?? "").split(delimiter).some((dir) =>
    exts.some((ext) => {
      try {
        accessSync(join(dir, bin + ext), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function version(bin: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      if (err) return resolve(undefined);
      resolve(`${stdout}${stderr}`.trim().split("\n")[0]?.trim() || undefined);
    });
  });
}

const canListen = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

async function portState(port: number): Promise<"free" | "tide" | "busy"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/env`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { environmentId?: unknown };
    if (typeof body.environmentId === "string") return "tide";
  } catch {
    // nothing that speaks Tide there
  }
  // both binds: macOS lets 127.0.0.1 bind beside a 0.0.0.0 listener and vice versa
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "0.0.0.0")) ? "free" : "busy";
}

export function hostProbes(env: NodeJS.ProcessEnv = process.env): DoctorProbes {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return {
    version,
    onPath,
    port: portState,
    runtime: bun !== undefined ? { name: "bun", version: bun.version } : { name: "node", version: process.version },
    tideHome: tideHomeOf(env),
  };
}

/** `tide doctor`: prints the checks; resolves with the exit code (1 when anything failed). */
export async function runDoctor(port: number | undefined, probes: DoctorProbes = hostProbes()): Promise<{ text: string; code: number }> {
  const checks = await runChecks(probes, port ?? readRuntime(probes.tideHome)?.port ?? 3777);
  return { text: formatChecks(checks), code: checks.some((c) => c.level === "fail") ? 1 : 0 };
}
