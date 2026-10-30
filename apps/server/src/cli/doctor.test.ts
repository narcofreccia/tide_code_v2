import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChecks, runDoctor, type DoctorProbes } from "./doctor.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const home = mkdtempSync(join(tmpdir(), "tide-doctor-"));
  dirs.push(home);
  return {
    version: async (bin) => `${bin} 1.0.0`,
    onPath: (bin) => bin !== "rg",
    port: async () => "free",
    runtime: { name: "node", version: "v22.13.0" },
    tideHome: home,
    ...overrides,
  };
}

describe("tide doctor", () => {
  it("passes on a healthy host and warns about optional tools", async () => {
    const result = await runDoctor(3777, probes());
    expect(result.code).toBe(0);
    expect(result.text).toMatch(/\[ {2}ok {2}\] node\s+v22\.13\.0/);
    expect(result.text).toMatch(/\[ warn \] rg\s+not found/);
    expect(result.text).toMatch(/port 3777\s+free/);
  });

  it("fails on old node, no harness, a corrupt server.json and a busy port", async () => {
    const p = probes({ runtime: { name: "node", version: "v20.11.0" }, onPath: (bin) => bin === "git", port: async () => "busy" });
    writeFileSync(join(p.tideHome, "server.json"), "{");
    const checks = await runChecks(p, 4000);
    const failed = checks.filter((c) => c.level === "fail").map((c) => c.name);
    expect(failed).toEqual(["node", "harnesses", "server.json", "port 4000"]);
  });

  it("a running Tide server on the port is fine", async () => {
    const checks = await runChecks(probes({ port: async () => "tide" }), 3777);
    expect(checks.at(-1)).toMatchObject({ level: "ok", detail: "a Tide server is already running there" });
  });
});
