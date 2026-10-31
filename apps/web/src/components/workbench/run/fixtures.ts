import type { Project, RunPlan, RunPlanRow, RunRepo, RunService, RunServiceStatus, RunSession } from "@tide/contracts";

export const svc = (id: string, patch: Partial<RunService> = {}): RunService => ({
  id,
  name: id,
  command: `run ${id}`,
  listens: [],
  connects: [],
  env: {},
  readiness: { kind: "none" },
  ...patch,
});

export const repo = (repoId: string, repoKey: string, services: RunService[] | undefined, patch: Partial<RunRepo> = {}): RunRepo => ({
  repoId,
  repoKey,
  path: `/src/${repoKey}`,
  label: repoKey,
  stale: false,
  ...(services === undefined
    ? {}
    : { profile: { version: 1 as const, repoKey, services, source: "manifest" as const, manifestHash: "h", generatedAt: 1, warnings: [] } }),
  ...patch,
});

export const project = (patch: Partial<Project> = {}): Project => ({
  id: "p1",
  title: "Reel",
  rootPath: "/src/backend",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

export const status = (state: RunServiceStatus["state"], patch: Partial<RunServiceStatus> = {}): RunServiceStatus => ({
  state,
  ports: {},
  since: 1,
  ...patch,
});

export const planRow = (key: string, patch: Partial<RunPlanRow> = {}): RunPlanRow => ({
  key,
  name: key.split(".")[1] ?? key,
  repoKey: key.split(".")[0] ?? key,
  repoId: "root",
  cwd: "/src",
  command: "run",
  ports: {},
  changedFrom: {},
  env: {},
  fixed: false,
  readiness: { kind: "none" },
  dependsOn: [],
  ...patch,
});

export const plan = (rows: RunPlanRow[], patch: Partial<RunPlan> = {}): RunPlan => ({
  status: "ok",
  rows,
  conflicts: [],
  warnings: [],
  host: "192.168.1.2",
  plannedAt: 1,
  ...patch,
});

export const session = (services: Record<string, RunServiceStatus>, patch: Partial<RunSession> = {}): RunSession => ({
  projectId: "p1",
  startedAt: 1,
  services,
  ...patch,
});

/** backend (api + redis), frontend (web), pos_app (metro, off by default), and a linked repo missing here. */
export const REPOS: RunRepo[] = [
  repo("root", "backend", [
    svc("api", { name: "api", kind: "uvicorn", listens: [{ name: "http", port: 8000, how: "flag", flag: "--port" }] }),
    svc("redis", { name: "redis" }),
  ]),
  repo("l1", "frontend", [svc("web", { name: "web", kind: "vite", listens: [{ name: "http", port: 8081, how: "flag", flag: "--port" }] })], {
    stale: true,
  }),
  repo("l2", "pos_app", [svc("metro", { name: "metro", kind: "expo", default: false, listens: [{ name: "http", port: 8081, how: "flag" }] })]),
  repo("l3", "gone", undefined, { error: "path missing on this machine: /src/gone" }),
];
