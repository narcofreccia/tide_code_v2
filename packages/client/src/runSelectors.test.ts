import { describe, expect, it } from "vitest";
import type { RunRepo, RunService, RunServiceStatus, RunSession } from "@tide/contracts";
import { previewPort, runSummary, stackServices } from "./runSelectors.ts";

const svc = (id: string, patch: Partial<RunService> = {}): RunService => ({
  id,
  name: id,
  command: `run ${id}`,
  listens: [],
  connects: [],
  env: {},
  readiness: { kind: "none" },
  ...patch,
});

const repo = (repoId: string, repoKey: string, services: RunService[], patch: Partial<RunRepo> = {}): RunRepo => ({
  repoId,
  repoKey,
  path: `/r/${repoKey}`,
  label: repoKey,
  stale: false,
  profile: { version: 1, repoKey, services, source: "manifest", manifestHash: "h", generatedAt: 1, warnings: [] },
  ...patch,
});

const status = (state: RunServiceStatus["state"]): RunServiceStatus => ({ state, ports: {}, since: 1 });

describe("stackServices", () => {
  const repos = [
    repo("root", "backend", [svc("api"), svc("redis")]),
    repo("l1", "pos_app", [svc("metro", { default: false })]),
    (({ profile: _drop, ...rest }) => ({ ...rest, error: "path missing" }))(repo("l2", "gone", [])),
  ];

  it("selects every service not marked default:false when the project has no selection", () => {
    const flat = stackServices(repos, {});
    expect(flat.map((s) => [s.key, s.selected])).toEqual([
      ["backend.api", true],
      ["backend.redis", true],
      ["pos_app.metro", false],
    ]);
    expect(flat[2]).toMatchObject({ repoId: "l1", repoKey: "pos_app", repoLabel: "pos_app" });
  });

  it("follows the saved selection when there is one", () => {
    const flat = stackServices(repos, { runStack: { selected: ["pos_app.metro"], pins: {} } });
    expect(flat.filter((s) => s.selected).map((s) => s.key)).toEqual(["pos_app.metro"]);
  });
});

describe("runSummary", () => {
  it("is empty without a session", () => {
    expect(runSummary(undefined)).toEqual({ up: 0, total: 0, worst: undefined });
  });

  it("counts up services and reports the worst state", () => {
    const session: RunSession = {
      projectId: "p1",
      startedAt: 1,
      services: { "a.x": status("running"), "a.y": status("starting"), "b.z": status("external") },
    };
    expect(runSummary(session)).toEqual({ up: 2, total: 3, worst: "starting" });
    session.services["b.w"] = status("failed");
    expect(runSummary(session).worst).toBe("failed");
  });

  it("counts planned rows that have not reported yet, never blocked ones", () => {
    const row = (key: string, blocked?: string) => ({
      key, name: key, repoKey: "a", repoId: "root", cwd: "/", command: "c", ports: {}, changedFrom: {}, env: {},
      fixed: false, readiness: { kind: "none" as const }, dependsOn: [], ...(blocked === undefined ? {} : { blocked }),
    });
    const session: RunSession = {
      projectId: "p1",
      startedAt: 1,
      services: { "a.x": status("running") },
      plan: { status: "ok", rows: [row("a.x"), row("a.y"), row("a.z", "port taken")], conflicts: [], warnings: [], host: "h", plannedAt: 1 },
    };
    expect(runSummary(session)).toEqual({ up: 1, total: 2, worst: "running" });
  });
});

describe("previewPort", () => {
  it("prefers http, skips sockets", () => {
    expect(previewPort({ hmr: 1421, http: 1420 })).toBe(1420);
    expect(previewPort({ hmr: 1421, metro: 8081 })).toBe(8081);
    expect(previewPort({ sync: 9 })).toBeUndefined();
  });
});
