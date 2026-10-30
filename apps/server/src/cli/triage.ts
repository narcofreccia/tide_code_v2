import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { formatChecks, hostProbes, runChecks, type DoctorProbes } from "./doctor.ts";
import { readRuntime, readToken } from "./runtime.ts";

const LOG_LINES = 200;

/** Replaces every secret we know of, plus anything that looks like an API key or token. */
export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) if (s !== undefined && s.length >= 6) out = out.split(s).join("[redacted]");
  return out
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/([?&](?:token|wsTicket|key)=)[^&\s"']+/g, "$1[redacted]");
}

const SECRET_KEY = /(key|token|secret|password|authorization)/i;

/** settings.json with every secret-looking field blanked (by key name) and the rest scrubbed. */
export function redactSettings(raw: string, secrets: Array<string | undefined>): string {
  try {
    const scrub = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(scrub);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, SECRET_KEY.test(k) && typeof val === "string" && val !== "" ? "[redacted]" : scrub(val)]));
      }
      return v;
    };
    return redact(JSON.stringify(scrub(JSON.parse(raw)), null, 2), secrets);
  } catch {
    return redact(raw, secrets);
  }
}

export interface TriageInput {
  probes: DoctorProbes;
  version: string;
  binary: string;
  port?: number;
  now?: Date;
  /** override for tests; defaults to the real files under tideHome */
  readFile?: (path: string) => string | undefined;
}

const readOr = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function decisionsKey(settingsRaw: string | undefined): string | undefined {
  if (settingsRaw === undefined) return undefined;
  try {
    const key = (JSON.parse(settingsRaw) as { decisions?: { apiKey?: unknown } }).decisions?.apiKey;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The redacted report as markdown. Pure over the inputs. */
export async function buildReport(input: TriageInput): Promise<string> {
  const home = input.probes.tideHome;
  const read = input.readFile ?? readOr;
  const settingsRaw = read(join(home, "settings.json"));
  const secrets = [readToken(home), decisionsKey(settingsRaw)];
  const checks = await runChecks(input.probes, input.port ?? readRuntime(home)?.port ?? 3777);
  const log = read(join(home, "logs", "server.log"));
  const tail = log === undefined ? undefined : log.split("\n").slice(-LOG_LINES - 1).join("\n").trimEnd();
  const fence = (body: string): string => `\`\`\`\n${body}\n\`\`\``;
  const rt = input.probes.runtime;
  return redact(
    [
      "# Tide triage report",
      "",
      `Generated ${(input.now ?? new Date()).toISOString()}. Secrets are redacted; read it before sharing.`,
      "",
      "## Environment",
      `- tide: ${input.version}`,
      `- binary: ${input.binary}`,
      `- os: ${platform()} ${release()} (${arch()})`,
      `- runtime: ${rt.name} ${rt.version}`,
      `- TIDE_HOME: ${home}`,
      "",
      "## Doctor",
      fence(formatChecks(checks)),
      "",
      "## settings.json (redacted)",
      settingsRaw === undefined ? "_not present_" : fence(redactSettings(settingsRaw, secrets)),
      "",
      `## Last ${LOG_LINES} lines of logs/server.log (redacted)`,
      tail === undefined ? "_no log file (the server logs to stderr unless started with --log or as a service)_" : fence(tail),
      "",
    ].join("\n"),
    secrets,
  );
}

/** A GitHub-issue body: the same facts without the settings dump. */
export function issueBody(report: string): string {
  const keep = report.split("\n## settings.json")[0] as string;
  const logs = report.includes("\n## Last") ? `\n## Last${report.split("\n## Last")[1] as string}` : "";
  return `${keep.replace("# Tide triage report", "### What happened\n\n<!-- describe the problem -->\n\n### Diagnostics")}${logs}`.trimEnd();
}

export interface TriageResult {
  text: string;
  code: number;
  file: string;
}

export async function runTriage(opts: { issue: boolean; noAgent: boolean; port?: number }, input: TriageInput): Promise<TriageResult> {
  const report = await buildReport(input);
  const dir = join(input.probes.tideHome, "triage");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}.md`);
  writeFileSync(file, report, { mode: 0o600 });
  const lines = [`wrote ${file}`];
  if (opts.issue) lines.push("", "--- GitHub issue body (paste into github.com/narcofreccia/tide_code_v2/issues/new) ---", issueBody(report));
  else if (!opts.noAgent) {
    lines.push("", "To get help from your harness (nothing is launched for you; the agent sees only this file):", `  claude "Read ${file} and help me fix Tide on this machine"`, `  codex "Read ${file} and help me fix Tide on this machine"`);
  }
  return { text: lines.join("\n"), code: 0, file };
}

export { hostProbes };
