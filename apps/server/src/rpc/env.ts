import { spawn } from "node:child_process";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import type { ProviderKind, RpcOutput } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { BUNDLED_KINDS, type DriverRegistry } from "../provider/registry.ts";
import { instanceIdOf } from "../provider/sessions.ts";
import type { SettingsStore } from "../settings.ts";
import type { PairingCodes } from "./pairing.ts";
import type { RemoteInfo } from "./remote.ts";
import { RpcException, type RpcRouter } from "./router.ts";

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

/** Threads with a turn in flight right now, by harness kind. */
export function runningByKind(engine: Engine, registry: DriverRegistry): Map<ProviderKind, number> {
  const out = new Map<ProviderKind, number>();
  for (const thread of Object.values(engine.getModel().threads)) {
    if (thread.status !== "running") continue;
    const kind = registry.kindOf(instanceIdOf(thread)) ?? thread.provider;
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

export function hostFacts(busyThreads: number): HostFacts {
  const cores = Math.max(1, cpus().length);
  const load = (loadavg()[0] ?? 0) / cores;
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    cpus: cores,
    cpuLoad: Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0)),
    memTotal: totalmem(),
    memFree: freemem(),
    busyThreads,
  };
}

/** HTTP base URLs a client can pair against: LAN addresses, the relay's client URL, else loopback. */
export function pairingUrls(remote: RemoteInfo, relay: RelayState | undefined): string[] {
  const lan = remote.lanUrls.map((ws) => ws.replace(/^ws:/, "http:").replace(/\/ws$/, ""));
  const urls = lan.length > 0 ? lan : [`http://127.0.0.1:${remote.port}`];
  if (relay?.connected && relay.clientUrl !== undefined) urls.push(relay.clientUrl);
  return urls;
}

export interface EnvDeps {
  engine: Engine;
  registry: DriverRegistry;
  settings?: Pick<SettingsStore, "get">;
  pairing: PairingCodes;
  remote: (options: { includePairing: boolean }) => RemoteInfo;
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
    host: hostFacts(busy),
    harnesses,
    ...(sshHost !== undefined && sshHost.length > 0 ? { sshHost } : {}),
    ...(relay !== undefined ? { relay } : {}),
  };
}

export function registerEnvHandlers(router: RpcRouter, deps: EnvDeps): void {
  router.register("env.pairingCode", async () => {
    const { code, expiresAt } = deps.pairing.issue();
    return { code, expiresAt, urls: pairingUrls(deps.remote({ includePairing: false }), deps.relayState?.()) };
  });

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
            emit({ kind, line: `${kind}: skipped, ${running} thread(s) running on it; retry when they settle`, done: true, ok: false });
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
