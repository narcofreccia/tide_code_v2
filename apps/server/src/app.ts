import type { ServerConfig } from "./config.ts";
import { ExpertsReactor } from "./experts/reactor.ts";
import { TideMcpProvisioner } from "./mcp/provision.ts";
import { AgentTokenStore } from "./rpc/agentTickets.ts";
import { Engine } from "./orchestration/engine.ts";
import { openEventStore, type EventStore } from "./orchestration/store.ts";
import { registerBundledDrivers } from "./provider/load.ts";
import { ProviderReactor } from "./provider/reactor.ts";
import { DriverRegistry } from "./provider/registry.ts";
import { SessionDirectory } from "./provider/sessions.ts";
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
  const sessions = new SessionDirectory({ registry, mcp, log });

  // The vcs reactor subscribes first on purpose: it must mark a turn's before-checkpoint
  // gate while `turn.requested` is delivered, before the provider reactor queues the turn.
  const worktrees = new WorktreeManager({ tideHome: config.tideHome, log });
  const checkpoints = new CheckpointService({ log });
  const vcs = new VcsReactor({
    engine,
    worktrees,
    checkpoints,
    sessions,
    ...(options.gh !== undefined ? { gh: options.gh } : {}),
    log,
  });
  vcs.start();

  const reactor = new ProviderReactor({
    engine,
    sessions,
    beforeTurn: (_threadId, turnId) => checkpoints.beforeReady(turnId),
    log,
  });
  reactor.start();

  const experts = new ExpertsReactor({ engine, log });
  experts.start();

  const workspace = createWorkspaceServices({ engine, log });

  const server =
    options.listen === false
      ? undefined
      : await startServer({ engine, store, registry, checkpoints, workspace, agentTokens, config: { ...config, environmentId } });
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
    agentTokens,
    mcp,
    worktrees,
    checkpoints,
    vcs,
    workspace,
    server,
    async close() {
      reactor.stop();
      experts.stop();
      vcs.stop();
      workspace.close();
      await server?.close();
      await sessions.closeAll();
      await registry.dispose();
      store.close();
    },
  };
}
