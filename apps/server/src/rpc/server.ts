import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { newId, type DiscoveredPeer } from "@tide/contracts";
import { findBinaryOnPath } from "@tide/contracts/cli";
import type { ServerConfig } from "../config.ts";
import type { Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import type { AcpRegistry } from "../provider/acpRegistry.ts";
import type { CommandsCache } from "../provider/commands.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import type { GhLike } from "../vcs/gh.ts";
import { GitHubForge } from "../vcs/forge/github.ts";
import { ForgeResolver } from "../vcs/forge/resolver.ts";
import { registerProjectIconHandlers } from "./projectIcon.ts";
import { loadProjectRepos, registerRunProfileHandlers } from "./run.ts";
import { sweepAttachments } from "../workspace/attachments.ts";
import { registerPrHandlers } from "./pr.ts";
import { AgentTokenStore } from "./agentTickets.ts";
import { registerAgentHandlers } from "./agent.ts";
import { registerAgentDiffHandler } from "./agentDiff.ts";
import { registerAgentThreadHandlers } from "./agentThreads.ts";
import { registerAgentSecretHandlers } from "./agentSecrets.ts";
import type { DelegateWaits } from "../orchestration/delegation.ts";
import { registerHandlers } from "./handlers.ts";
import { registerProviderHandlers } from "./providers.ts";
import { registerSearchHandlers } from "./search.ts";
import { registerUsageHandlers } from "./usage.ts";
import { SettingsStore } from "../settings.ts";
import type { JudgeLedger } from "../decisions/ledger.ts";
import { buildRemoteInfo, isLoopbackHost, lanIps, type Interfaces } from "./remote.ts";
import { browse } from "./mdns/browser.ts";
import { MdnsResponder } from "./mdns/responder.ts";
import type { MdnsSocketFactory } from "./mdns/socket.ts";
import { PROTOCOL_VERSION } from "../version.ts";
import { deviceGuard, envInfo, registerEnvHandlers, type EnvDeps, type RelayState } from "./env.ts";
import { ClientTokenStore } from "./clientTokens.ts";
import { createHttpHandler } from "./http.ts";
import { ALLOWED_HOSTS_ENV, createHostPolicy, hostRefusal, parseAllowedHosts, relayOriginOf } from "./hostOrigin.ts";
import { PairingCodes, safeEqual } from "./pairing.ts";
import { registerRunStackHandlers } from "./runStack.ts";
import { registerVcsHandlers } from "./vcs.ts";
import { createWorkspaceServices, registerWorkspaceHandlers, type WorkspaceServices } from "./workspace.ts";
import { threadCwdResolver } from "./threadCwd.ts";
import { RpcRouter } from "./router.ts";
import { TicketIssuer } from "./tickets.ts";
import { createListener, schemes } from "./tls.ts";

const PING_INTERVAL_MS = 30_000;

/** Host tools the UI may want to know about (Settings › Git); a cheap PATH scan at boot. */
function detectTools(): { git: boolean; gh: boolean; rg: boolean } {
  return {
    git: findBinaryOnPath("git") !== undefined,
    gh: findBinaryOnPath("gh") !== undefined,
    rg: findBinaryOnPath("rg") !== undefined,
  };
}

export interface ServerDeps {
  engine: Engine;
  store: EventStore;
  config: ServerConfig;
  /** omitted in tests that don't exercise providers: an empty registry is used */
  registry?: DriverRegistry;
  /** omitted in tests that don't exercise git: a stand-alone service is used */
  checkpoints?: CheckpointService;
  /** tests inject a fake GitHub CLI; shared with the vcs reactor by the app */
  gh?: GhLike;
  /** files/watcher/search/terminals; the app builds these once and owns their lifetime */
  workspace?: WorkspaceServices;
  /** per-thread agent tokens; the app shares this with the MCP provisioner */
  agentTokens?: AgentTokenStore;
  /** tests mock the host's network interfaces to assert the LAN URL shape */
  networkInterfaces?: () => Interfaces;
  /** user settings; the app shares one store with the decisions client */
  settings?: SettingsStore;
  /** R6: the judge's spend ledger (`decisions.stats`); defaults to one over `store` */
  judgeLedger?: JudgeLedger;
  /** shared with the delegation reactor: a parent blocked in agent.thread.wait gets no wake-up */
  delegateWaits?: DelegateWaits;
  /** R8: the `/` picker cache, fed by the provider reactor */
  commands?: CommandsCache;
  /** R8: the ACP agent registry the instance factory resolves against */
  acp?: AcpRegistry;
  /** R9: pairing codes; the app shares them with `tide serve`'s boot banner */
  pairing?: PairingCodes;
  /** R9: the relay client's state, when this server dials out to one */
  relayState?: () => RelayState | undefined;
  /** R9: tests replace the harness updaters */
  runUpdate?: EnvDeps["runUpdate"];
  /** R10: forge detection shared with PR watch; a GitHub-only resolver when omitted */
  forges?: ForgeResolver;
  /** R17: per-device tokens; in memory unless config.settingsPath says where clients.json lives */
  clientTokens?: ClientTokenStore;
  /** R18: extra Host names to answer to; default: TIDE_ALLOWED_HOSTS from the environment */
  allowedHosts?: string[];
  /** R17: LAN discovery over mDNS; tests hand in fake sockets */
  discovery?: { socketFactory?: MdnsSocketFactory; browse?: (timeoutMs: number) => Promise<DiscoveredPeer[]> };
}

export interface ServerHandle {
  port: number;
  host: string;
  url: string;
  pairing: PairingCodes;
  clientTokens: ClientTokenStore;
  /** R17: closes every socket a paired device opened (code 4401 "revoked"); returns how many */
  closeClient(clientId: string): number;
  /** R17: true while the mDNS responder advertises this server on the LAN */
  readonly discovery: { readonly advertising: boolean };
  close(): Promise<void>;
}

/** What a socket may do: an agent socket speaks for a thread; a paired device's socket carries its client id. */
interface Privileges {
  agentThreadId?: string;
  clientId?: string;
}

export async function startServer(deps: ServerDeps): Promise<ServerHandle> {
  const { config, engine, store } = deps;
  const startedAt = Date.now();
  const tickets = new TicketIssuer();
  const agentTokens = deps.agentTokens ?? new AgentTokenStore();
  const pairing = deps.pairing ?? new PairingCodes();
  const clientTokens = deps.clientTokens ?? new ClientTokenStore(config.settingsPath !== undefined ? { path: ClientTokenStore.pathFor(config.settingsPath) } : {});
  /** sockets opened with a paired device's ticket, so revoking the device drops them */
  const clientSockets = new Map<WebSocket, string>();
  const closeClient = (clientId: string): number => {
    let closed = 0;
    for (const [ws, id] of clientSockets) {
      if (id !== clientId) continue;
      clientSockets.delete(ws);
      ws.close(4401, "revoked");
      closed++;
    }
    return closed;
  };

  const registry =
    deps.registry ?? new DriverRegistry({ env: { dataDir: config.dataDir, log: (msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)) } });

  // the real port is only known after listen(); every remote lookup reads it late
  let boundPort = config.port;
  let responder: MdnsResponder | undefined;
  const mdnsSockets = deps.discovery?.socketFactory !== undefined ? { socketFactory: deps.discovery.socketFactory } : {};
  const remote = ({ includePairing }: { includePairing: boolean }) => ({
    ...buildRemoteInfo({
      host: config.host,
      port: boundPort,
      token: config.token,
      includePairing,
      tls: config.tls !== undefined,
      ...(deps.networkInterfaces !== undefined ? { interfaces: deps.networkInterfaces() } : {}),
    }),
    ...(responder !== undefined ? { discovery: { advertising: responder.enabled } } : {}),
  });

  const router = new RpcRouter();
  // R19: the level is read per call, so a change from the owner reaches already open sockets; a
  // device unknown to the store (revoked mid-call) gets the narrowest level
  router.guard((method, params, ctx) =>
    deviceGuard(method, params, ctx, ctx.clientId === undefined ? "full" : (clientTokens.accessOf(ctx.clientId) ?? "limited")),
  );
  const settings = deps.settings ?? new SettingsStore(config.dataDir === ":memory:" ? {} : { path: SettingsStore.pathFor(config.tideHome) });
  const envDeps: EnvDeps = {
    engine,
    registry,
    settings,
    pairing,
    clients: { store: clientTokens, closeClient },
    remote,
    discover: deps.discovery?.browse ?? ((timeoutMs) => browse({ timeoutMs, selfEnvironmentId: config.environmentId, ...mdnsSockets })),
    ...(deps.relayState !== undefined ? { relayState: deps.relayState } : {}),
    ...(deps.runUpdate !== undefined ? { runUpdate: deps.runUpdate } : {}),
  };
  registerEnvHandlers(router, envDeps);
  const forges = deps.forges ?? new ForgeResolver({ forges: [new GitHubForge()] });
  registerHandlers(router, {
    envInfo: () => envInfo(envDeps),
    engine,
    store,
    registry,
    environmentId: config.environmentId,
    version: config.version,
    startedAt,
    tideHome: config.tideHome,
    tools: detectTools(),
    ghAuth: () => forges.ghAuth(),
    remote,
    settings,
    deviceAccess: (clientId) => clientTokens.accessOf(clientId),
    ...(deps.judgeLedger !== undefined ? { judgeLedger: deps.judgeLedger } : {}),
  });
  registerProviderHandlers(router, {
    engine,
    registry,
    settings,
    dataDir: config.dataDir,
    ...(deps.commands !== undefined ? { commands: deps.commands } : {}),
    ...(deps.acp !== undefined ? { acp: deps.acp } : {}),
  });
  registerSearchHandlers(router, { engine });
  registerUsageHandlers(router, { engine, settings, store, tideHome: config.tideHome, dataDir: config.dataDir });
  registerPrHandlers(router, { engine, forges });
  const cwdFor = threadCwdResolver(engine);
  registerAgentHandlers(router, { engine, cwdFor, registry, providerDefaults: () => settings.get().providerDefaults });
  registerAgentThreadHandlers(router, {
    engine,
    cwdFor,
    registry,
    ...(deps.delegateWaits !== undefined ? { waits: deps.delegateWaits } : {}),
    ...(deps.settings !== undefined ? { grayZone: () => (deps.settings as SettingsStore).get().decisions.grayZone } : {}),
  });
  registerAgentSecretHandlers(router, { engine, tideHome: config.tideHome });
  const checkpoints = deps.checkpoints ?? new CheckpointService();
  registerAgentDiffHandler(router, { engine, checkpoints });
  registerVcsHandlers(router, {
    engine,
    checkpoints,
    ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
  });
  const workspace = deps.workspace ?? createWorkspaceServices({ engine });
  const ownsWorkspace = deps.workspace === undefined;
  registerWorkspaceHandlers(router, workspace);
  const runProfileDeps = { engine, registry, settings, tideHome: config.tideHome };
  const runStack = registerRunStackHandlers(router, { engine, workspace, profilesFor: (projectId, rootPath) => loadProjectRepos(runProfileDeps, projectId, rootPath) });
  registerProjectIconHandlers(router, { engine });
  registerRunProfileHandlers(router, runProfileDeps);
  // no-worktree threads write attachments into the project root; drop upload dirs older than 30 days
  void (async () => {
    let removed = 0;
    for (const p of Object.values(engine.getModel().projects)) removed += await sweepAttachments(p.rootPath, Date.now());
    if (removed > 0) console.error(`[attachments] removed ${removed} upload dir(s) older than 30 days`);
  })().catch(() => undefined);

  const hosts = createHostPolicy({ environmentId: config.environmentId, allowedHosts: deps.allowedHosts ?? parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]) });
  // R19: HTTPS/WSS on the same single listener when a certificate is configured
  const http: Server = createListener(
    createHttpHandler({
      config,
      tickets,
      pairing,
      clientTokens,
      remote,
      envName: () => settings.get().environment.name,
      webhook: { engine, settings },
      hosts,
      relayOrigin: () => relayOriginOf(deps.relayState?.()?.url),
    }),
    config.tls,
  );

  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  /** null = rejected; otherwise the connection's privileges. */
  const authorize = (url: URL): Privileges | null => {
    const agentToken = url.searchParams.get("agentToken");
    if (agentToken !== null) {
      const agentThreadId = agentTokens.resolve(agentToken);
      return agentThreadId === undefined ? null : { agentThreadId };
    }
    const ticket = url.searchParams.get("wsTicket");
    const grant = ticket ? tickets.consume(ticket) : undefined;
    if (grant !== undefined) {
      // a ticket bought before its device was revoked dies with it
      if (grant.clientId !== undefined && !clientTokens.has(grant.clientId)) return null;
      return grant;
    }
    // raw tokens on the socket: the master token, and only in --dev; device tokens always go through a ticket
    const token = url.searchParams.get("token");
    return config.dev && token !== null && safeEqual(token, config.token) ? {} : null;
  };

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // R18: the same Host rule as HTTP (DNS rebinding); refused before the handshake
    if (!hosts.allowsHost(req.headers.host)) {
      const body = hostRefusal(req.headers.host);
      socket.end(`HTTP/1.1 421 Misdirected Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const authorized = authorize(url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authorized) {
        // complete the handshake so the client sees a meaningful close code
        ws.close(4401, "unauthorized");
        return;
      }
      wss.emit("connection", ws, req, authorized);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage, privileges: Privileges = {}) => {
    alive.set(ws, true);
    const { clientId } = privileges;
    const options = { ...(privileges.agentThreadId !== undefined ? { agentThreadId: privileges.agentThreadId } : {}), ...(clientId !== undefined ? { clientId } : {}) };
    if (clientId !== undefined) {
      clientSockets.set(ws, clientId);
      clientTokens.touch(clientId, req.socket.remoteAddress ?? "unknown");
      ws.on("close", () => clientSockets.delete(ws));
    }
    const connection = router.connection(
      newId(),
      (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      options,
    );
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => {
      void connection.handleMessage(typeof data === "string" ? data : data.toString());
    });
    ws.on("close", () => connection.close());
    ws.on("error", () => connection.close());
  });

  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  keepalive.unref?.();

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(config.port, config.host, () => {
      http.off("error", rej);
      res();
    });
  });

  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  boundPort = port;

  // R17: a server other machines can reach says so on the LAN (`_tide._tcp`)
  if (!isLoopbackHost(config.host)) {
    const wildcard = config.host === "0.0.0.0" || config.host === "::" || config.host === "";
    responder = new MdnsResponder({
      environmentId: config.environmentId,
      name: () => settings.get().environment.name,
      version: config.version,
      protocol: PROTOCOL_VERSION,
      port,
      tls: config.tls !== undefined,
      ips: () => (wildcard ? lanIps(deps.networkInterfaces?.()) : [config.host]),
      ...mdnsSockets,
      log: (msg) => console.error(msg),
    });
    await responder.start();
  }

  return {
    port,
    host: config.host,
    url: `${schemes(config.tls !== undefined).ws}://${config.host}:${port}/ws`,
    pairing,
    clientTokens,
    closeClient,
    discovery: {
      get advertising() {
        return responder?.enabled ?? false;
      },
    },
    async close() {
      clearInterval(keepalive);
      await responder?.stop();
      clientTokens.flush();
      runStack.close();
      if (ownsWorkspace) workspace.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
