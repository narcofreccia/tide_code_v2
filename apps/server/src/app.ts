import type { ImageInput } from "@tide/contracts";
import type { ServerConfig } from "./config.ts";
import { createDecisionClient, type Transport } from "./decisions/client.ts";
import { TriageReactor } from "./decisions/reactor.ts";
import { ExpertsReactor } from "./experts/reactor.ts";
import { TideMcpProvisioner } from "./mcp/provision.ts";
import { AgentTokenStore } from "./rpc/agentTickets.ts";
import { Engine } from "./orchestration/engine.ts";
import { recoverUnsettledTurns, SHUTDOWN_ERROR, unsettledTurns } from "./orchestration/recovery.ts";
import { openEventStore, type EventStore } from "./orchestration/store.ts";
import { registerBundledDrivers } from "./provider/load.ts";
import { ProviderReactor } from "./provider/reactor.ts";
import { DriverRegistry } from "./provider/registry.ts";
import { SessionDirectory } from "./provider/sessions.ts";
import { SettingsStore } from "./settings.ts";
import { startServer, type ServerHandle } from "./rpc/server.ts";
import { createWorkspaceServices, type WorkspaceServices } from "./rpc/workspace.ts";
import { CheckpointService } from "./vcs/checkpoints.ts";
import type { GhLike } from "./vcs/gh.ts";
import { VcsReactor } from "./vcs/reactor.ts";
import { WorktreeManager } from "./vcs/worktrees.ts";

export interface AppOptions {
  config: ServerConfig;
  /** already-open store (tests use ":memory:"); otherwise opened from config.dbPath */
  store?: EventStore;
  /** tests register fakes here; production falls back to the bundled driver packages */
  registerDrivers?: (registry: DriverRegistry) => void | Promise<void>;
  /** false keeps everything in-process without binding a socket */
  listen?: boolean;
  /** tests inject a fake GitHub CLI */
  gh?: GhLike;
  /** tests replace the TypeSafe HTTP transport (and may pass a store with decisions enabled) */
  decisionsTransport?: Transport;
  settings?: SettingsStore;
  /** how long close() waits for in-flight reactor work before giving up */
  shutdownTimeoutMs?: number;
  /** tests that restart an app on the same in-memory store */
  keepStoreOpen?: boolean;
  log?: (msg: string, data?: unknown) => void;
}

export interface App {
  config: ServerConfig;
  environmentId: string;
  store: EventStore;
  engine: Engine;
  registry: DriverRegistry;
  sessions: SessionDirectory;
  reactor: ProviderReactor;
  experts: ExpertsReactor;
  triage: TriageReactor;
  settings: SettingsStore;
  agentTokens: AgentTokenStore;
  mcp: TideMcpProvisioner;
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  vcs: VcsReactor;
  workspace: WorkspaceServices;
  server: ServerHandle | undefined;
  close(): Promise<void>;
}

/**
 * Composition root: event store -> engine -> driver registry -> session directory ->
 * reactor -> RPC server. Tests build the same graph in memory with a fake driver.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const { config } = options;
  const log = options.log ?? ((msg: string, data?: unknown) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  const store = options.store ?? (await openEventStore(config.dbPath));

  // The env id lives in the log too, so a copied database keeps its identity.
  const persisted = store.getMeta("environmentId");
  if (persisted === undefined) store.setMeta("environmentId", config.environmentId);
  const environmentId = persisted ?? config.environmentId;

  const engine = new Engine({ store });
  const registry = new DriverRegistry({ env: { dataDir: config.dataDir, log } });
  if (options.registerDrivers) await options.registerDrivers(registry);
  else await registerBundledDrivers(registry, config.providers, log);

  // Every provider session gets the Tide MCP server, parameterised by a per-thread
  // agent token that is revoked when the session closes.
  const agentTokens = new AgentTokenStore();
  const mcp = new TideMcpProvisioner({ tokens: agentTokens });
  const sessions = new SessionDirectory({ registry, mcp, log, model: () => engine.getModel() });

  // The vcs reactor subscribes first on purpose: it must mark a turn's before-checkpoint
  // gate while `turn.requested` is delivered, before the provider reactor queues the turn.
  const workspace = createWorkspaceServices({ engine, log });
  const worktrees = new WorktreeManager({ tideHome: config.tideHome, log });
  const checkpoints = new CheckpointService({ log });
  const vcs = new VcsReactor({
    engine,
    worktrees,
    checkpoints,
    sessions,
    ...(options.gh !== undefined ? { gh: options.gh } : {}),
    onDetach: (threadId, worktreePath) => workspace.teardown(threadId, worktreePath),
    log,
  });
  vcs.start();

  const reactor = new ProviderReactor({
    engine,
    sessions,
    beforeTurn: (_threadId, turnId) => checkpoints.beforeReady(turnId),
    imagesFor: (turnId) => imagesOf(store, turnId),
    log,
  });
  reactor.start();

  const experts = new ExpertsReactor({ engine, log });
  experts.start();

  // One settings store for the RPC server and the decisions client.
  const settings = options.settings ?? new SettingsStore({ ...(config.dataDir === ":memory:" ? {} : { path: SettingsStore.pathFor(config.tideHome) }), log });
  const triage = new TriageReactor({
    engine,
    client: createDecisionClient({ settings, log, ...(options.decisionsTransport !== undefined ? { transport: options.decisionsTransport } : {}) }),
    log,
  });
  triage.start();

  // After every reactor subscribed: the dead turns' settles must reach the vcs reactor (after-
  // checkpoint), the experts reactor (expert status) and the provider reactor (which runs the
  // queued turn each settle promotes).
  await recoverUnsettledTurns(engine, { log, resume: (threadId, turnId) => reactor.resume(threadId, turnId) });

  const server =
    options.listen === false
      ? undefined
      : await startServer({
          engine,
          store,
          registry,
          checkpoints,
          workspace,
          agentTokens,
          settings,
          ...(options.gh !== undefined ? { gh: options.gh } : {}),
          config: { ...config, environmentId },
        });
  if (server) mcp.setUrl(`ws://${config.host}:${server.port}/ws`);

  return {
    config,
    environmentId,
    store,
    engine,
    registry,
    sessions,
    reactor,
    experts,
    triage,
    settings,
    agentTokens,
    mcp,
    worktrees,
    checkpoints,
    vcs,
    workspace,
    server,
    async close() {
      // 1. no new turn can be picked up: the reactors stop listening and the socket goes away
      reactor.stop();
      experts.stop();
      triage.stop();
      vcs.stop();
      await server?.close();

      // 2. whatever is mid-flight is asked to stop and then settled, so a restart finds a
      //    clean log instead of a thread wedged on `running`
      // queued turns were never sent to a harness: they survive the restart and run after recovery
      for (const turn of unsettledTurns(engine.getModel()).filter((t) => t.status !== "queued")) {
        try {
          await sessions.peek(turn.threadId)?.interrupt();
        } catch (err) {
          log("[app] interrupt on shutdown failed", err);
        }
        try {
          await engine.dispatch({ type: "turn.settle", turnId: turn.id, status: "interrupted", error: SHUTDOWN_ERROR });
        } catch (err) {
          log("[app] settle on shutdown failed", err);
        }
      }

      // 3. give the reactors a bounded window to finish their git/driver work before the
      //    store they write into is closed under them
      await withTimeout(Promise.all([reactor.drain(), vcs.drain(), triage.drain()]), options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, log);

      workspace.close();
      await sessions.closeAll();
      await registry.dispose();
      if (!options.keepStoreOpen) store.close();
    },
  };
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Image bytes ride only on `turn.requested`; a turn promoted after a restart reads them back from the log. */
function imagesOf(store: EventStore, turnId: string): ImageInput[] | undefined {
  for (const record of store.readAll()) {
    const event = record.event;
    if (event.type === "turn.requested" && event.turn.id === turnId) return event.images;
  }
  return undefined;
}

/** Never let a wedged reactor hold the process open; the store must close either way. */
async function withTimeout(work: Promise<unknown>, ms: number, log: (msg: string, data?: unknown) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
  // handled up front: when the timeout wins, a later rejection must not surface unhandled
  const guarded = work.then(
    () => "done" as const,
    (err: unknown) => {
      log("[app] reactor drain failed during shutdown", err);
      return "done" as const;
    },
  );
  if ((await Promise.race([guarded, bail])) === "timeout") log("[app] shutdown timed out waiting for reactors to drain");
  if (timer) clearTimeout(timer);
}
