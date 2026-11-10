import { spawn } from "node:child_process";
import { arch, cpus, freemem, hostname, platform, totalmem } from "node:os";
import type { DeviceAccess, DiscoveredPeer, ProviderKind, RpcOutput } from "@tide/contracts";
import { threadsWithBackgroundChildren } from "../orchestration/background.ts";
import type { Engine } from "../orchestration/engine.ts";
import { BUNDLED_KINDS, type DriverRegistry } from "../provider/registry.ts";
import { instanceIdOf } from "../provider/sessions.ts";
import type { SettingsStore } from "../settings.ts";
import { cpuUsage, memAvailable } from "./hostLoad.ts";
import type { ClientTokenStore } from "./clientTokens.ts";
import { limitedRefusal } from "./deviceAccess.ts";
import type { PairingCodes } from "./pairing.ts";
import type { RemoteInfo } from "./remote.ts";
import { RpcException, type RpcCallContext, type RpcRouter } from "./router.ts";

type ServerInfo = RpcOutput<"server.info">;
export type HostFacts = NonNullable<ServerInfo["host"]>;
export type RelayState = NonNullable<ServerInfo["relay"]>;

/** Each harness's own updater (the install hints in packages/driver-*\/src/status.ts name the same packages). */
export const UPDATE_COMMANDS: Partial<Record<ProviderKind, { command: string; args: string[] }>> = {
  claude: { command: "claude", args: ["update"] },
  codex: { command: "npm", args: ["i", "-g", "@openai/codex@latest"] },
  opencode: { command: "opencode", args: ["upgrade"] },
  pi: { command: "npm", args: ["i", "-g", "@earendil-works/pi-coding-agent@latest"] },
};

/** Runs one command, reporting stdout/stderr line by line; resolves with the exit code. */
export type UpdateRunner = (command: string, args: string[], onLine: (line: string) => void, signal: AbortSignal) => Promise<number | null>;

export const spawnUpdate: UpdateRunner = (command, args, onLine, signal) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"], shell: platform() === "win32", env: process.env });
    const pipe = (stream: NodeJS.ReadableStream): void => {
      let partial = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const lines = (partial + chunk).split(/\r?\n|\r/);
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim().length > 0) onLine(line);
      });
      stream.on("end", () => {
        if (partial.trim().length > 0) onLine(partial);
        partial = "";
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("error", (err) => {
      onLine(`${command}: ${err.message}`);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

/**
 * Busy threads right now, by harness kind: a turn in flight, or sub-agents still working in the
 * background after their turn settled (they live inside the harness process). Each thread counts once.
 */
export function runningByKind(engine: Engine, registry: DriverRegistry): Map<ProviderKind, number> {
  const model = engine.getModel();
  const background = new Set(threadsWithBackgroundChildren(model));
  const out = new Map<ProviderKind, number>();
  for (const thread of Object.values(model.threads)) {
    const busy = thread.status === "running" || background.has(thread.id);
    if (!busy) continue;
    const kind = registry.kindOf(instanceIdOf(thread)) ?? thread.provider;
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/** `memFree` is memory the OS can hand out (see hostLoad.ts); `cpuLoad` is a rolling CPU-time sample. */
export function hostFacts(busyThreads: number, memFree: number = freemem()): HostFacts {
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    cpus: Math.max(1, cpus().length),
    cpuLoad: cpuUsage(),
    memTotal: totalmem(),
    memFree,
    busyThreads,
  };
}

/** HTTP base URLs a client can pair against: LAN addresses, the relay's client URL, else loopback. */
export function pairingUrls(remote: RemoteInfo, relay: RelayState | undefined): string[] {
  // R19: wss:// → https:// when the server listens with TLS
  const lan = remote.lanUrls.map((ws) => ws.replace(/^ws(s?):/, "http$1:").replace(/\/ws$/, ""));
  const urls = lan.length > 0 ? lan : [`${remote.tls === true ? "https" : "http"}://127.0.0.1:${remote.port}`];
  if (relay?.connected && relay.clientUrl !== undefined) urls.push(relay.clientUrl);
  return urls;
}

const DISCOVER_DEFAULT_MS = 1500;
const DISCOVER_MIN_MS = 200;
const DISCOVER_MAX_MS = 5000;

export interface EnvDeps {
  engine: Engine;
  registry: DriverRegistry;
  settings?: Pick<SettingsStore, "get">;
  pairing: PairingCodes;
  /** R17: paired devices and a way to drop their open sockets on revoke */
  clients?: { store: ClientTokenStore; closeClient(clientId: string): number };
  remote: (options: { includePairing: boolean }) => RemoteInfo;
  /** R17: asks the LAN for other Tide servers (mDNS); rejects when no socket can be opened */
  discover?: (timeoutMs: number) => Promise<DiscoveredPeer[]>;
  /** the relay client's state (apps/server/src/relay) when one is configured */
  relayState?: () => RelayState | undefined;
  runUpdate?: UpdateRunner;
}

/** The R9 fields of `server.info`: host load, harness versions, ssh host, relay. */
export async function envInfo(deps: EnvDeps): Promise<Pick<ServerInfo, "host" | "harnesses" | "sshHost" | "relay">> {
  const busy = [...runningByKind(deps.engine, deps.registry).values()].reduce((a, b) => a + b, 0);
  const statuses = await deps.registry.statusAll();
  const harnesses = statuses
    .filter((s) => s.id === s.kind && BUNDLED_KINDS.includes(s.kind))
    .map((s) => ({ kind: s.kind, installed: s.installed, ...(s.version !== undefined ? { version: s.version } : {}) }));
  const sshHost = deps.settings?.get().environment.sshHost;
  const relay = deps.relayState?.();
  return {
    host: hostFacts(busy, await memAvailable()),
    harnesses,
    ...(sshHost !== undefined && sshHost.length > 0 ? { sshHost } : {}),
    ...(relay !== undefined ? { relay } : {}),
  };
}

/**
 * What a paired device may not do. A socket whose ticket came from a device token (`ctx.clientId`)
 * never decides who else gets in or how the machine is exposed (R18, every device). R19: a
 * `limited` device is further held to the table in deviceAccess.ts. Owner = master token
 * (desktop shell, dev browser, CLI): never restricted. `access` is the device's level, looked up
 * per call by the caller. `env.clients.list` is not refused: its handler answers a device with its
 * own row only.
 */
export function deviceGuard(method: string, params: unknown, ctx: Pick<RpcCallContext, "clientId">, access: DeviceAccess = "full"): string | undefined {
  const clientId = ctx.clientId;
  if (clientId === undefined) return undefined;
  switch (method) {
    case "env.pairingCode":
      return "only the machine's owner can pair new devices; open Tide on that machine (or run `tide pair` there)";
    case "env.clients.setAccess":
      return "only the machine's owner can change a device's access; change it on the machine itself";
    case "env.clients.revoke":
      // a device may unpair itself, not the others
      return (params as { id?: unknown }).id === clientId ? undefined : "a paired device can revoke only itself; revoke other devices from the machine itself";
    case "settings.set": {
      const patch = (params as { patch?: { relay?: unknown; environment?: { lanBind?: unknown } } }).patch;
      if (patch?.relay !== undefined) return "a paired device cannot change the relay settings; change them on the machine itself";
      if (patch?.environment?.lanBind !== undefined) return "a paired device cannot change whether the machine is reachable on the LAN; change it on the machine itself";
      break;
    }
  }
  return access === "full" ? undefined : limitedRefusal(method, params);
}

export function registerEnvHandlers(router: RpcRouter, deps: EnvDeps): void {
  router.register("env.pairingCode", async ({ access }) => {
    const { code, expiresAt } = deps.pairing.issue(access !== undefined ? { access } : {});
    return { code, expiresAt, urls: pairingUrls(deps.remote({ includePairing: false }), deps.relayState?.()) };
  });

  // R17: Tide servers on the LAN, for "Add machine"; enabled: false when this host cannot browse
  router.register("env.discover", async ({ timeoutMs }) => {
    if (deps.discover === undefined) return { peers: [], enabled: false };
    const timeout = Math.min(DISCOVER_MAX_MS, Math.max(DISCOVER_MIN_MS, timeoutMs ?? DISCOVER_DEFAULT_MS));
    try {
      return { peers: await deps.discover(timeout), enabled: true };
    } catch {
      return { peers: [], enabled: false };
    }
  });

  // agent sockets never reach env.* (the router keeps them to agent.*); a device sees and may
  // revoke only its own row (deviceGuard refuses the rest)
  router.register("env.clients.list", async (_input, ctx) => {
    const all = deps.clients?.store.list() ?? [];
    return { clients: ctx.clientId === undefined ? all : all.filter((c) => c.id === ctx.clientId) };
  });
  router.register("env.clients.revoke", async ({ id }) => {
    // ok: false = no such device (already revoked, or a typo)
    const clients = deps.clients;
    if (clients === undefined || !clients.store.revoke(id)) return { ok: false };
    clients.closeClient(id);
    return { ok: true };
  });

  router.register("env.clients.setAccess", async ({ id, access }) => ({ ok: deps.clients?.store.setAccess(id, access) ?? false }));

  let updating = false;
  const run = deps.runUpdate ?? spawnUpdate;
  router.registerStream("env.updateHarnesses", async (input, ctx, emit) => {
    if (updating) throw new RpcException("busy", "a harness update is already running on this machine");
    updating = true;
    const abort = new AbortController();
    const kinds = input.kinds ?? BUNDLED_KINDS.filter((k) => deps.registry.has(k));
    void (async () => {
      let allOk = true;
      try {
        for (const kind of kinds) {
          if (abort.signal.aborted) break;
          const update = UPDATE_COMMANDS[kind];
          if (update === undefined) {
            emit({ kind, line: `${kind}: no update command; update it the way you installed it`, done: true, ok: false });
            allOk = false;
            continue;
          }
          const running = runningByKind(deps.engine, deps.registry).get(kind) ?? 0;
          if (running > 0) {
            emit({ kind, line: `${kind}: skipped, ${running} thread(s) busy on it (a turn or background sub-agents); retry when they finish`, done: true, ok: false });
            allOk = false;
            continue;
          }
          emit({ kind, line: `$ ${update.command} ${update.args.join(" ")}` });
          const code = await run(update.command, update.args, (line) => emit({ kind, line }), abort.signal);
          const status = await deps.registry.status(kind, true).catch(() => undefined);
          const ok = code === 0;
          if (!ok) allOk = false;
          emit({ kind, line: ok ? `${kind}: ${status?.version ?? "updated"}` : `${kind}: update failed (exit ${code ?? "error"})`, done: true, ok });
        }
        emit({ line: allOk ? "all harnesses updated" : "finished with problems", done: true, ok: allOk });
      } finally {
        updating = false;
        ctx.cancelStream(ctx.requestId); // ends the stream for the client
      }
    })();
    return () => abort.abort();
  });
}
