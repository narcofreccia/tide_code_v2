import { describe, expect, it } from "vitest";
import type { RunListen, RunRepo, RunService } from "@tide/contracts";
import { planStack, withPortFlag, type PlanInput } from "./plan.ts";

const svc = (id: string, over: Partial<RunService> = {}): RunService => ({
  id,
  name: id,
  command: `run ${id}`,
  listens: [],
  connects: [],
  env: {},
  readiness: { kind: "none" },
  ...over,
});
const repo = (repoKey: string, services: RunService[], repoId = repoKey): RunRepo => ({
  repoId,
  repoKey,
  path: `/src/${repoKey}`,
  label: repoKey,
  stale: false,
  profile: { version: 1, repoKey, services, source: "manifest", manifestHash: "h", generatedAt: 0, warnings: [] },
});
const env = (port: number, envVar: string, name = "http"): RunListen => ({ name, port, how: "env", envVar });
const fixed = (port: number, name = "http"): RunListen => ({ name, port, how: "fixed" });
const flag = (port: number, over: Partial<RunListen> = {}): RunListen => ({ name: "http", port, how: "flag", flag: "--port", ...over });

const plan = (repos: RunRepo[], over: Partial<PlanInput> = {}) =>
  planStack({
    repos,
    selected: repos.flatMap((r) => (r.profile?.services ?? []).map((s) => `${r.repoKey}.${s.id}`)),
    pins: {},
    listening: [],
    ownPorts: new Set(),
    host: "192.168.1.20",
    now: 42,
    ...over,
  });

// the shapes of Andrea's repos (plan §1)
const backend = repo("backend", [
  svc("redis", { command: "redis-server" }),
  svc("api", {
    command: "uvicorn app.main:app --reload --port 8000",
    kind: "uvicorn",
    listens: [flag(8000)],
    connects: [{ env: "CLIENT_URL", to: "frontend.web", template: "http://localhost:${port}" }],
    readiness: { kind: "port" },
  }),
  svc("celery", { command: "celery -A app worker", dependsOn: ["redis"] }),
]);
const frontend = repo("frontend", [
  svc("web", {
    command: "pnpm dev",
    kind: "vite",
    listens: [flag(8081, { strictFlag: "--strictPort" })],
    connects: [{ env: "VITE_API_URL", to: "backend.api", template: "http://localhost:${port}" }],
  }),
]);
const pos2 = repo("pos2", [
  svc("app", {
    command: "pnpm tauri dev",
    kind: "tauri",
    listens: [fixed(1420), env(8090, "TIDE_SYNC_PORT", "sync")],
    connects: [{ env: "TIDE_DEV_BASE_URL", to: "backend.api", template: "http://localhost:${port}" }],
  }),
]);
const reel = repo("reel", [svc("gui", { command: "pnpm tauri dev", kind: "tauri", listens: [fixed(1420), fixed(1421, "hmr")] })]);
const posApp = repo("pos_app", [
  svc("metro", {
    command: "npx expo start",
    kind: "expo",
    listens: [flag(8081)],
    connects: [{ env: "DEV_SERVER_URL", to: "backend.api", template: "http://${host}:${port}" }],
    default: false,
  }),
]);

describe("planStack", () => {
  it("keeps every preferred port when nothing collides", () => {
    const p = plan([backend, frontend]);
    expect(p.status).toBe("ok");
    expect(p.rows.map((r) => [r.key, r.ports])).toEqual([
      ["backend.redis", {}],
      ["backend.api", { http: 8000 }],
      ["backend.celery", {}],
      ["frontend.web", { http: 8081 }],
    ]);
    expect(p.rows.every((r) => Object.keys(r.changedFrom).length === 0)).toBe(true);
    expect(p.rows.find((r) => r.key === "backend.api")?.cwd).toBe("/src/backend");
    expect(p).toMatchObject({ host: "192.168.1.20", plannedAt: 42, conflicts: [] });
  });

  it("orders by dependsOn within a repo and warns on cycles", () => {
    const r = repo("x", [svc("b", { dependsOn: ["a"] }), svc("a")]);
    expect(plan([r]).rows.map((row) => [row.key, row.dependsOn])).toEqual([["x.a", []], ["x.b", ["x.a"]]]);
    const cyc = repo("y", [svc("a", { dependsOn: ["b"] }), svc("b", { dependsOn: ["a"] })]);
    const p = plan([cyc]);
    expect(p.rows.map((row) => row.key)).toEqual(["y.a", "y.b"]);
    expect(p.warnings.some((w) => w.includes("cycle"))).toBe(true);
  });

  it("moves a movable listen away from an external listener", () => {
    const p = plan([frontend], { listening: [{ port: 8081, pid: 77, command: "node" }] });
    expect(p.status).toBe("ok");
    expect(p.rows[0]).toMatchObject({ ports: { http: 8082 }, changedFrom: { http: 8081 }, command: "pnpm dev --port 8082 --strictPort" });
  });

  it("ignores listeners that belong to our own running session", () => {
    const p = plan([frontend], { listening: [{ port: 8081, pid: 77, command: "node" }], ownPorts: new Set([8081]) });
    expect(p.rows[0]?.ports).toEqual({ http: 8081 });
  });

  it("gives three movables on 8081 distinct ports, the later ones with changedFrom", () => {
    const sync = repo("pos2s", [svc("sync", { listens: [env(8081, "PORT")] })]);
    const p = plan([frontend, posApp, sync], { selected: ["frontend.web", "pos_app.metro", "pos2s.sync"] });
    expect(p.rows.map((r) => r.ports["http"])).toEqual([8081, 8082, 8083]);
    expect(p.rows.map((r) => r.changedFrom)).toEqual([{}, { http: 8081 }, { http: 8081 }]);
    expect(p.rows[2]?.env["PORT"]).toBe("8083");
  });

  it("blocks fixed vs fixed, naming both services, and still plans the rest", () => {
    const p = plan([reel, pos2, frontend]);
    expect(p.status).toBe("blocked");
    expect(p.conflicts).toEqual([
      { key: "pos2.app.http", port: 1420, with: "reel.gui", reason: "pos2.app needs fixed port 1420, already taken by reel.gui" },
    ]);
    const row = p.rows.find((r) => r.key === "pos2.app");
    expect(row?.blocked).toContain("reel.gui");
    expect(row?.ports).toEqual({ http: 1420, sync: 8090 });
    expect(p.rows.find((r) => r.key === "reel.gui")?.blocked).toBeUndefined();
    expect(p.rows.find((r) => r.key === "frontend.web")?.ports).toEqual({ http: 8081 });
  });

  it("blocks a fixed listen against an external listener, naming the pid", () => {
    const p = plan([reel], { listening: [{ port: 1421, pid: 900, command: "vite" }] });
    expect(p.conflicts[0]).toMatchObject({ key: "reel.gui.hmr", with: "external pid 900 (vite)" });
  });

  it("moves the movable for a fixed listen, whichever comes first", () => {
    const vite = repo("aaa", [svc("web", { listens: [flag(1420)] })]);
    for (const repos of [[vite, reel], [reel, vite]]) {
      const p = plan(repos);
      expect(p.status).toBe("ok");
      expect(p.rows.find((r) => r.key === "reel.gui")?.ports).toEqual({ http: 1420, hmr: 1421 });
      expect(p.rows.find((r) => r.key === "aaa.web")).toMatchObject({ ports: { http: 1422 }, changedFrom: { http: 1420 } });
    }
  });

  it("honours a pin and blocks when the pinned port is busy", () => {
    expect(plan([frontend], { pins: { "frontend.web.http": 5173 } }).rows[0]).toMatchObject({ ports: { http: 5173 }, changedFrom: {} });
    const busy = plan([frontend], { pins: { "frontend.web.http": 5173 }, listening: [{ port: 5173, pid: 5, command: "node" }] });
    expect(busy.status).toBe("blocked");
    expect(busy.conflicts[0]).toMatchObject({ key: "frontend.web.http", port: 5173, with: "external pid 5 (node)" });
  });

  it("renders connects from the assigned ports", () => {
    const p = plan([backend, frontend, posApp], {
      selected: ["backend.api", "frontend.web", "pos_app.metro"],
      listening: [{ port: 8000, pid: 1, command: "python" }],
    });
    const api = p.rows.find((r) => r.key === "backend.api");
    expect(api?.ports).toEqual({ http: 8001 });
    expect(api?.env["CLIENT_URL"]).toBe("http://localhost:8081");
    expect(p.rows.find((r) => r.key === "frontend.web")?.env["VITE_API_URL"]).toBe("http://localhost:8001");
    expect(p.rows.find((r) => r.key === "pos_app.metro")?.env["DEV_SERVER_URL"]).toBe("http://192.168.1.20:8001");
  });

  it("uses the default port of a connect target outside the stack, with a warning", () => {
    const p = plan([backend, frontend], { selected: ["frontend.web"] });
    expect(p.rows[0]?.env["VITE_API_URL"]).toBe("http://localhost:8000");
    expect(p.warnings).toContain("frontend.web: VITE_API_URL → backend.api not in the stack; using its default");
  });

  it("renders an unresolved ?:N connect with N and warns", () => {
    const r = repo("z", [svc("w", { connects: [{ env: "API", to: "?:9000", template: "${port}" }] })]);
    const p = plan([r]);
    expect(p.rows[0]?.env["API"]).toBe("9000");
    expect(p.warnings.some((w) => w.includes("9000"))).toBe(true);
  });

  it("adds -- for npm run, not for pnpm", () => {
    const l = flag(3000);
    expect(withPortFlag("npm run dev", l, 3001)).toBe("npm run dev -- --port 3001");
    expect(withPortFlag("npm run dev -- --host", l, 3001)).toBe("npm run dev -- --host --port 3001");
    expect(withPortFlag("pnpm dev", l, 3001)).toBe("pnpm dev --port 3001");
    expect(withPortFlag("npx vite", l, 3001)).toBe("npx vite --port 3001");
    expect(withPortFlag("vite", { ...l, flagStyle: "equals" }, 3001)).toBe("vite --port=3001");
  });

  it("does not double --strictPort and replaces an existing --port", () => {
    const l = flag(8081, { strictFlag: "--strictPort" });
    expect(withPortFlag("vite --port 8081 --strictPort", l, 8082)).toBe("vite --strictPort --port 8082");
    expect(withPortFlag("pnpm dev --port 3000", flag(3000), 3005)).toBe("pnpm dev --port 3005");
    expect(withPortFlag("pnpm dev --port=3000", flag(3000), 3005)).toBe("pnpm dev --port 3005");
    expect(withPortFlag("npm run dev -- --port 3000", flag(3000), 3005)).toBe("npm run dev -- --port 3005");
  });

  it("re-renders every connect when the backend is pinned to 8010", () => {
    const p = plan([backend, frontend, pos2], { selected: ["backend.api", "frontend.web", "pos2.app"], pins: { "backend.api.http": 8010 } });
    expect(p.status).toBe("ok");
    expect(p.rows.find((r) => r.key === "backend.api")).toMatchObject({ ports: { http: 8010 }, command: "uvicorn app.main:app --reload --port 8010" });
    expect(p.rows.find((r) => r.key === "frontend.web")?.env["VITE_API_URL"]).toBe("http://localhost:8010");
    expect(p.rows.find((r) => r.key === "pos2.app")?.env["TIDE_DEV_BASE_URL"]).toBe("http://localhost:8010");
  });

  it("warns about unknown selections and dependencies outside the stack", () => {
    const p = plan([backend], { selected: ["backend.celery", "nope.x"] });
    expect(p.rows.map((r) => r.key)).toEqual(["backend.celery"]);
    expect(p.rows[0]?.dependsOn).toEqual([]);
    expect(p.warnings).toEqual(expect.arrayContaining(["nope.x: no such service", "backend.celery depends on backend.redis, which is not in the stack"]));
  });
});
