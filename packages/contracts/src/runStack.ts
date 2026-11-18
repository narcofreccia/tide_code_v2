import { Type, type Static } from "typebox";

// ---- R13: Run stack. A RunProfile describes how one repo (the project root or a linked repo) is
// started for development. It lives IN the repo (`<repo>/.tide/run.json`, twin block in
// QUICKSTART.md), never in the event log: a linked repo is shared by several projects. ----
export const RunListen = Type.Object({
  /** "http", "hmr", "ws", "sync" */
  name: Type.String({ minLength: 1 }),
  /** preferred port */
  port: Type.Number({ minimum: 1, maximum: 65535 }),
  /** how a different port is handed to the process; `fixed` = cannot move (Tauri devUrl) */
  how: Type.Union([Type.Literal("env"), Type.Literal("flag"), Type.Literal("fixed")]),
  envVar: Type.Optional(Type.String()),
  flag: Type.Optional(Type.String()),
  flagStyle: Type.Optional(Type.Union([Type.Literal("space"), Type.Literal("equals")])),
  /** appended whenever a port is passed, e.g. Vite's `--strictPort` so a taken port fails loudly instead of drifting */
  strictFlag: Type.Optional(Type.String()),
  /** fallback search range when the preferred port is busy; default [port+1, port+50] */
  range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
});
export type RunListen = Static<typeof RunListen>;

/** An env var this service reads to find another service: re-rendered with the port the plan assigned. */
export const RunConnect = Type.Object({
  env: Type.String({ minLength: 1 }),
  /** `<repoKey>.<serviceId>[.<listenName>]`; `?:<port>` while unresolved (scanner saw a localhost URL, no owner yet) */
  to: Type.String({ minLength: 1 }),
  /** `${port}` and `${host}` are substituted; host = this machine's LAN IP at plan time */
  template: Type.String({ minLength: 1 }),
});
export type RunConnect = Static<typeof RunConnect>;

export const RunReadiness = Type.Union([
  Type.Object({ kind: Type.Literal("port"), listen: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("log"), pattern: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("none") }),
]);
export type RunReadiness = Static<typeof RunReadiness>;

export const RunServiceKind = Type.Union([
  Type.Literal("vite"), Type.Literal("tauri"), Type.Literal("expo"), Type.Literal("uvicorn"), Type.Literal("node"), Type.Literal("worker"), Type.Literal("other"),
]);
export type RunServiceKind = Static<typeof RunServiceKind>;

export const RunService = Type.Object({
  /** slug, unique within the profile */
  id: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" }),
  name: Type.String({ minLength: 1 }),
  /** relative to the repo root; default "." */
  cwd: Type.Optional(Type.String()),
  /** written into the user's shell as typed */
  command: Type.String({ minLength: 1, maxLength: 2000 }),
  listens: Type.Array(RunListen),
  connects: Type.Array(RunConnect),
  /** static env, overridden by listens/connects the plan renders */
  env: Type.Record(Type.String(), Type.String()),
  readiness: RunReadiness,
  kind: Type.Optional(RunServiceKind),
  /** service ids started (and ready) first, e.g. redis before celery */
  dependsOn: Type.Optional(Type.Array(Type.String())),
  /** selected in the stack by default (false for a phone app that needs a simulator) */
  default: Type.Optional(Type.Boolean()),
});
export type RunService = Static<typeof RunService>;

export const RunProfileSource = Type.Union([Type.Literal("quickstart"), Type.Literal("manifest"), Type.Literal("model"), Type.Literal("user")]);
export type RunProfileSource = Static<typeof RunProfileSource>;

export const RunProfile = Type.Object({
  version: Type.Literal(1),
  /** the label used in `RunConnect.to`; default = basename of the repo directory */
  repoKey: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9_-]*$" }),
  services: Type.Array(RunService),
  source: RunProfileSource,
  /** sha1 over the scanned manifest bytes; differs ⇒ "stale" */
  manifestHash: Type.String(),
  generatedAt: Type.Number(),
  /** e.g. "loads .env with override: true — injected env is ignored" */
  warnings: Type.Array(Type.String()),
});
export type RunProfile = Static<typeof RunProfile>;

/** A repo of a project's stack as the server sees it right now. */
export const RunRepo = Type.Object({
  /** "root" or the link id */
  repoId: Type.String(),
  repoKey: Type.String(),
  path: Type.String(),
  label: Type.String(),
  profile: Type.Optional(RunProfile),
  stale: Type.Boolean(),
  /** path missing on this machine, invalid QUICKSTART block, … */
  error: Type.Optional(Type.String()),
});
export type RunRepo = Static<typeof RunRepo>;

export const RunConflict = Type.Object({
  /** `<repoKey>.<serviceId>.<listen>` */
  key: Type.String(),
  port: Type.Number(),
  /** the other party: another service key, or "external pid N (command)" */
  with: Type.String(),
  reason: Type.String(),
});
export type RunConflict = Static<typeof RunConflict>;

export const RunPlanRow = Type.Object({
  /** `<repoKey>.<serviceId>` */
  key: Type.String(),
  name: Type.String(),
  repoKey: Type.String(),
  repoId: Type.String(),
  /** absolute */
  cwd: Type.String(),
  /** final command, flags appended */
  command: Type.String(),
  /** assigned ports by listen name */
  ports: Type.Record(Type.String(), Type.Number()),
  /** preferred ports that moved, by listen name */
  changedFrom: Type.Record(Type.String(), Type.Number()),
  env: Type.Record(Type.String(), Type.String()),
  fixed: Type.Boolean(),
  readiness: RunReadiness,
  dependsOn: Type.Array(Type.String()),
  /** blocked rows are shown but not started */
  blocked: Type.Optional(Type.String()),
});
export type RunPlanRow = Static<typeof RunPlanRow>;

export const RunPlan = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("blocked")]),
  /** root repo path the rows were planned against (a worktree when `threadId` was given) */
  rootPath: Type.Optional(Type.String()),
  rootBranch: Type.Optional(Type.String()),
  rows: Type.Array(RunPlanRow),
  conflicts: Type.Array(RunConflict),
  warnings: Type.Array(Type.String()),
  /** LAN host used for `${host}` */
  host: Type.String(),
  plannedAt: Type.Number(),
});
export type RunPlan = Static<typeof RunPlan>;

export const RunServiceState = Type.Union([
  Type.Literal("starting"), Type.Literal("ready"), Type.Literal("running"), Type.Literal("exited"), Type.Literal("failed"),
  /** listening on its port but not started by this server (another terminal, or a previous server life) */
  Type.Literal("external"),
]);
export type RunServiceState = Static<typeof RunServiceState>;

export const RunServiceStatus = Type.Object({
  state: RunServiceState,
  ptyId: Type.Optional(Type.String()),
  pid: Type.Optional(Type.Number()),
  ports: Type.Record(Type.String(), Type.Number()),
  since: Type.Number(),
  exit: Type.Optional(Type.Object({ code: Type.Optional(Type.Number()), signal: Type.Optional(Type.String()) })),
  reason: Type.Optional(Type.String()),
});
export type RunServiceStatus = Static<typeof RunServiceStatus>;

/** Ephemeral: a project's running stack as this server sees it (lost with the server, like the processes). */
export const RunSession = Type.Object({
  projectId: Type.String(),
  startedAt: Type.Number(),
  /** when the root repo runs from a thread's worktree: that thread, its path and branch */
  worktree: Type.Optional(Type.Object({ threadId: Type.String(), path: Type.String(), branch: Type.Optional(Type.String()) })),
  plan: Type.Optional(RunPlan),
  services: Type.Record(Type.String(), RunServiceStatus),
});
export type RunSession = Static<typeof RunSession>;

/** Per project: which stack services are on, and port pins. Event-sourced (small, project-specific). */
export const RunStack = Type.Object({
  /** `<repoKey>.<serviceId>` */
  selected: Type.Array(Type.String()),
  /** `<repoKey>.<serviceId>.<listen>` → port */
  pins: Type.Record(Type.String(), Type.Number()),
});
export type RunStack = Static<typeof RunStack>;
