import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError, parseCli } from "./args.ts";
import type { DoctorProbes } from "./doctor.ts";
import { buildReport, issueBody, redact, redactSettings, runTriage } from "./triage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "tok_abcdef1234567890";
const APIKEY = "tsk_supersecretvalue";

function home(): DoctorProbes {
  const dir = mkdtempSync(join(tmpdir(), "tide-triage-"));
  dirs.push(dir);
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "server.json"), JSON.stringify({ environmentId: "env1", token: TOKEN }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ decisions: { apiKey: APIKEY, model: "m" }, relay: { url: "wss://r", key: "relaykey123456" } }));
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  lines.push(`auth Bearer ${TOKEN} and sk-abcdefghijklmnop and ghp_${"a".repeat(30)} and ${APIKEY}`);
  writeFileSync(join(dir, "logs", "server.log"), lines.join("\n"));
  return { version: async (b) => `${b} 1.0`, onPath: () => true, port: async () => "free", runtime: { name: "node", version: "v22.13.0" }, tideHome: dir };
}

describe("redact", () => {
  it("removes bearer tokens, sk-, ghp_, github_pat_, URL tokens and known secrets", () => {
    const out = redact(`Bearer abcdefghijklmnop sk-abcdefghij ghp_${"b".repeat(20)} github_pat_${"c".repeat(25)} ws://x/?token=zzz&a=1 mine-secret-1`, ["mine-secret-1"]);
    expect(out).not.toMatch(/abcdefghijklmnop|sk-abcdefghij|ghp_b|github_pat_c|token=zzz|mine-secret/);
    expect(out).toContain("a=1");
  });
  it("blanks secret-named settings fields", () => {
    const out = redactSettings(JSON.stringify({ decisions: { apiKey: "abc", model: "m" }, relay: { key: "k1" } }), []);
    expect(out).toContain('"model": "m"');
    expect(out).not.toMatch(/abc|k1/);
  });
});

describe("tide triage", () => {
  it("builds a redacted report with the last 200 log lines", async () => {
    const report = await buildReport({ probes: home(), version: "9.9.9", binary: "/bin/tide" });
    expect(report).toContain("- tide: 9.9.9");
    expect(report).toContain("## Doctor");
    for (const secret of [TOKEN, APIKEY, "sk-abcdefghijklmnop", "ghp_aaaa", "relaykey123456"]) expect(report).not.toContain(secret);
    expect(report).toContain("line 299");
    expect(report).not.toContain("line 50\n");
  });

  it("writes <TIDE_HOME>/triage/<time>.md and prints the paste command; --issue prints the body without settings", async () => {
    const probes = home();
    const input = { probes, version: "1.0.0", binary: "/bin/tide", now: new Date("2026-10-30T10:00:00Z") };
    const res = await runTriage({ issue: false, noAgent: false }, input);
    expect(res.file).toBe(join(probes.tideHome, "triage", "2026-10-30T10-00-00-000Z.md"));
    expect(readFileSync(res.file, "utf8")).toContain("# Tide triage report");
    expect(res.text).toContain(`claude "Read ${res.file} and help me fix Tide on this machine"`);
    const issue = await runTriage({ issue: true, noAgent: false }, input);
    expect(issue.text).toContain("### What happened");
    expect(issue.text).not.toContain("settings.json (redacted)");
    expect((await runTriage({ issue: false, noAgent: true }, input)).text).not.toContain("claude ");
    expect(issueBody("# Tide triage report\nx")).toContain("### Diagnostics");
  });

  it("parses args", () => {
    expect(parseCli(["triage"])).toEqual({ cmd: "triage", issue: false, noAgent: false });
    expect(parseCli(["triage", "--issue", "--no-agent", "--port", "4000"])).toEqual({ cmd: "triage", issue: true, noAgent: true, port: 4000 });
    expect(() => parseCli(["triage", "--bogus"])).toThrow(CliError);
  });
});
