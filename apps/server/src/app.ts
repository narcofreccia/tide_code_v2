import type { ImageInput } from "@tide/contracts";
import type { ServerConfig } from "./config.ts";
import type { Transport } from "./decisions/client.ts";
import type { Judge } from "./decisions/judge.ts";
import type { JudgeLedger } from "./decisions/ledger.ts";
import { TriageReactor } from "./decisions/reactor.ts";
import { HandoffSite } from "./decisions/sites/handoff.ts";
import { ApprovalsSite } from "./decisions/sites/approvals.ts";
import { DelegatesSite } from "./decisions/sites/delegates.ts";
import { ExpertsSite } from "./decisions/sites/experts.ts";
import { createJudgeService } from "./decisions/service.ts";
import { ExpertsReactor } from "./experts/reactor.ts";
import { TideMcpProvisioner } from "./mcp/provision.ts";
import { delegateTargetsHint } from "./provider/delegateTargets.ts";
import { AgentTokenStore } from "./rpc/agentTickets.ts";
import type { DecideDefaults } from "./orchestration/decider/index.ts";
import { Engine } from "./orchestration/engine.ts";
import { DelegateWaits, DelegationReactor, type CancelTimer } from "./orchestration/delegation.ts";
import { LimitsWorker } from "./orchestration/limits.ts";
import { SettlementReactor } from "./orchestration/settlement.ts";
import { continueAfterRestart, recoverRollbacks, recoverUnsettledTurns, SHUTDOWN_ERROR, unsettledTurns } from "./orchestration/recovery.ts";
import { RollbackService } from "./orchestration/rollback.ts";
import { openEventStore, type EventStore } from "./orchestration/store.ts";
import { AcpRegistry } from "./provider/acpRegistry.ts";
import { CommandsCache } from "./provider/commands.ts";
import { createBundledInstanceFactory, registerBundledDrivers } from "./provider/load.ts";
import { ProviderReactor } from "./provider/reactor.ts";
import { DriverRegistry, type InstanceFactory } from "./provider/registry.ts";
import { instanceIdOf, SessionDirectory, threadCwd } from "./provider/sessions.ts";
import { Scheduler } from "./scheduling/scheduler.ts";
import { startRelayClient, type RelayClient } from "./relay/client.ts";
import { SettingsStore } from "./settings.ts";
import { startServer, type ServerHandle } from "./rpc/server.ts";
import { PairingCodes } from "./rpc/pairing.ts";
import { localHostFor } from "./rpc/remote.ts";
import { createWorkspaceServices, type WorkspaceServices } from "./rpc/workspace.ts";
import { CheckpointService } from "./vcs/checkpoints.ts";
import { Gh, type GhLike } from "./vcs/gh.ts";
import { GitHubForge } from "./vcs/forge/github.ts";
import { ForgeResolver } from "./vcs/forge/resolver.ts";
import { PrWatcher } from "./vcs/prWatch.ts";
import { VcsReactor } from "./vcs/reactor.ts";
import { WorktreeManager } from "./vcs/worktrees.ts";

export interface AppOptions {
  config: ServerConfig;
  /** already-open store (tests use ":memory:"); otherwise opened from config.dbPath */
  store?: EventStore;
  /** tests register fakes here; production falls back to the bundled driver packages */
  registerDrivers?: (registry: DriverRegistry) => void | Promise<void>;
  /** R8: tests build settings instances from fakes; production maps them onto the bundled + ACP drivers */
  instanceFactory?: (acp: AcpRegistry) => InstanceFactory;
  /** tests replace the ACP registry (no network) */
  acp?: AcpRegistry;
  /** false keeps everything in-process without binding a socket */
  listen?: boolean;
  /** tests inject a fake GitHub CLI */
  gh?: GhLike;
  /** R10: tests inject a resolver over a fake forge; production detects GitHub from each repo's origin */
  forges?: ForgeResolver;
  /** tests replace the TypeSafe HTTP transport (and may pass a store with decisions enabled) */
  decisionsTransport?: Transport;
  settings?: SettingsStore;
  /** how long close() waits for in-flight reactor work before giving up */
  shutdownTimeoutMs?: number;
  /** tests drive the delegate wake-up batch window with a manual timer */
  delegationSchedule?: (fn: () => void, ms: number) => CancelTimer;
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
  acp: AcpRegistry;
  commands: CommandsCache;
  sessions: SessionDirectory;
  reactor: ProviderReactor;
  experts: ExpertsReactor;
  triage: TriageReactor;
  /** R6: the decision layer every site asks (Jev first, the user's harness in the gray zone) */
  judge: Judge;
  judgeLedger: JudgeLedger;
  settings: SettingsStore;
  agentTokens: AgentTokenStore;
  mcp: TideMcpProvisioner;
  worktrees: WorktreeManager;
  checkpoints: CheckpointService;
  vcs: VcsReactor;
  rollback: RollbackService;
  limits: LimitsWorker;
  settlement: SettlementReactor;
  delegation: DelegationReactor;
  delegateWaits: DelegateWaits;
  scheduler: Scheduler;
  /** R9: one-time pairing codes (`env.pairingCode`, `tide serve`'s banner) */
  pairing: PairingCodes;
  prWatch: PrWatcher;
  /** R10: which forge serves a checkout (PR tab, PR watch) */
  forges: ForgeResolver;
  workspace: WorkspaceServices;
  server: ServerHandle | undefined;
  /** R9: outbound uplink to the self-hosted relay (settings.relay), when listening */
  relay: RelayClient | undefined;
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

  // One settings store for the engine (decider defaults), the RPC server and the decisions client.
  const settings = options.settings ?? new SettingsStore({ ...(config.settingsPath === undefined ? {} : { path: config.settingsPath }), log });
  const engine = new Engine({ store, defaults: () => deciderDefaults(settings) });
  const registry = new DriverRegistry({ env: { dataDir: config.dataDir, log } });
  if (options.registerDrivers) await options.registerDrivers(registry);
  else await registerBundledDrivers(registry, config.providers, log);
  // R8: user-added accounts and ACP agents (settings.providerInstances), re-synced on settings.set
  const acp = options.acp ?? new AcpRegistry({ dataDir: config.dataDir, log });
  registry.setFactory(options.instanceFactory?.(acp) ?? createBundledInstanceFactory({ providers: config.providers, acp }));
  await registry.syncInstances(settings.get().providerInstances);
  // an agent added since the cached registry was fetched resolves once the fresh list is in
  if (settings.get().providerInstances.some((p) => p.kind === "acp" && p.command === undefined && p.acpAgentId !== undefined && acp.find(p.acpAgentId) === undefined)) {
    void acp.load(true).then(() => registry.syncInstances(settings.get().providerInstances)).catch((err: unknown) => log("[acp] resync failed", err));
  }
  const commands = new CommandsCache();

  // Every provider session gets the Tide MCP server, parameterised by a per-thread
  // agent token that is revoked when the session closes.
  const agentTokens = new AgentTokenStore();
  const mcp = new TideMcpProvisioner({ tokens: agentTokens });
  const sessions = new SessionDirectory({
    registry,
    mcp,
    log,
    model: () => engine.getModel(),
    harnessHint: () => delegateTargetsHint(registry, settings.get().providerDefaults),
  });
  registry.setInUse((instance) => sessions.usesInstance(instance));

  // The vcs reactor subscribes first on purpose: it must mark a turn's before-checkpoint
  // gate while `turn.requested` is delivered, before the provider reactor queues the turn.
  const workspace = createWorkspaceServices({ engine, log });
  const worktrees = new WorktreeManager({ tideHome: config.tideHome, log });
  const checkpoints = new CheckpointService({ log });
  const gh = options.gh ?? new Gh();
  const forges = options.forges ?? new ForgeResolver({ forges: [new GitHubForge()] });
  const prWatch = new PrWatcher({ engine, forges, log });
  const vcs = new VcsReactor({
    engine,
    worktrees,
    checkpoints,
    sessions,
    gh,
    onDetach: (threadId, worktreePath) => workspace.teardown(threadId, worktreePath),
    onPrChange: (threadId) => void prWatch.refresh(threadId),
    log,
  });
  vcs.start();

  // created with the judge below; a turn carrying a handoff waits briefly for its refine
  let handoffSite: HandoffSite | undefined;
  const reactor = new ProviderReactor({
    engine,
    sessions,
    handoffReady: (handoffId) => handoffSite?.pending(handoffId),
    beforeTurn: (_threadId, turnId) => checkpoints.beforeReady(turnId),
    imagesFor: (turnId) => imagesOf(store, turnId),
    onCommands: (threadId, list) => {
      const model = engine.getModel();
      const thread = model.threads[threadId];
      const project = thread ? model.projects[thread.projectId] : undefined;
      if (thread && project) commands.put(instanceIdOf(thread), threadCwd(thread, project), list, true);
    },
    log,
  });
  reactor.start();

  const experts = new ExpertsReactor({ engine, log });
  experts.start();

  const rollback = new RollbackService({ engine, sessions, checkpoints, exclusive: (threadId, task) => vcs.exclusive(threadId, task), log });
  rollback.start();
  const limits = new LimitsWorker({ engine, log });
  limits.start();
  const settlement = new SettlementReactor({ engine, settings, log });
  settlement.start();
  prWatch.start();

  const { judge, ledger: judgeLedger } = createJudgeService({
    settings,
    registry,
    store,
    dataDir: config.dataDir,
    log,
    ...(options.decisionsTransport !== undefined ? { transport: options.decisionsTransport } : {}),
  });
  const triage = new TriageReactor({ engine, judge, log });
  triage.start();
  handoffSite = new HandoffSite({ engine, judge, log });
  handoffSite.start();
  const grayZone = () => settings.get().decisions.grayZone;
  const decisionSites = [
    new DelegatesSite({ engine, judge, log }),
    new ApprovalsSite({ engine, judge, grayZone, log }),
    new ExpertsSite({ engine, judge, grayZone, autoAdvance: () => settings.get().decisions.expertsAutoAdvance, log }),
  ];
  for (const site of decisionSites) site.start();

  // After every reactor subscribed: the dead turns' settles must reach the vcs reactor (after-
  // checkpoint), the experts reactor (expert status) and the provider reactor (which runs the
  // queued turn each settle promotes).
  const recovered = await recoverUnsettledTurns(engine, { log, resume: (threadId, turnId) => reactor.resume(threadId, turnId) });
  await recoverRollbacks(engine, { log });
  if (settings.get().continueAfterRestart) await continueAfterRestart(engine, recovered.threadIds, { log });

  // after recovery: turns settled as "interrupted" by a restart must not wake their parents
  const delegateWaits = new DelegateWaits();
  const delegation = new DelegationReactor({ engine, waits: delegateWaits, grayZone, log, ...(options.delegationSchedule !== undefined ? { schedule: options.delegationSchedule } : {}) });
  delegation.start();

  // after recovery: a slot due during the downtime fires once, never as a burst
  const scheduler = new Scheduler({ engine, settings, log });
  scheduler.start();

  const pairing = new PairingCodes();
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
          judgeLedger,
          delegateWaits,
          commands,
          acp,
          pairing,
          relayState: () => relay?.state(),
          forges,
          ...(options.gh !== undefined ? { gh: options.gh } : {}),
          config: { ...config, environmentId },
        });
  // provider sessions on this machine reach the server over loopback, whatever the bind address
  if (server) mcp.setUrl(`ws://${localHostFor(config.host)}:${server.port}/ws`);
  const relay: RelayClient | undefined = server ? startRelayClient(settings, { environmentId, port: server.port, host: localHostFor(config.host), log }) : undefined;

  return {
    config,
    environmentId,
    store,
    engine,
    registry,
    acp,
    commands,
    sessions,
    reactor,
    experts,
    triage,
    judge,
    judgeLedger,
    settings,
    agentTokens,
    mcp,
    worktrees,
    checkpoints,
    vcs,
    rollback,
    limits,
    settlement,
    delegation,
    delegateWaits,
    scheduler,
    pairing,
    prWatch,
    forges,
    workspace,
    server,
    relay,
    async close() {
      // 1. no new turn can be picked up: the reactors stop listening and the socket goes away
      reactor.stop();
      experts.stop();
      triage.stop();
      handoffSite?.stop();
      vcs.stop();
      rollback.stop();
      limits.stop();
      settlement.stop();
      delegation.stop();
      for (const site of decisionSites) site.stop();
      scheduler.stop();
      relay?.stop();
      prWatch.stop();
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
      await withTimeout(Promise.all([reactor.drain(), vcs.drain(), triage.drain(), rollback.drain(), prWatch.drain(), scheduler.drain(), delegation.drain(), ...decisionSites.map((site) => site.drain())]), options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, log);

      workspace.close();
      await sessions.closeAll();
      await registry.dispose();
      if (!options.keepStoreOpen) store.close();
    },
  };
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** The slice of the user settings the decider applies to threads the server builds itself. */
function deciderDefaults(settings: SettingsStore): DecideDefaults {
  const s = settings.get();
  return {
    limitPolicy: s.limitPolicy,
    worktreeByDefault: s.worktreeByDefault,
    providerDefaults: s.providerDefaults,
    providerInstances: s.providerInstances.map((p) => ({ id: p.id, kind: p.kind })),
  };
}

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
