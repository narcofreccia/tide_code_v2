import { resolve } from "node:path";
import { createApp } from "../app.ts";
import { parseArgs, resolveConfig } from "../config.ts";
import { pairingUrls } from "../rpc/env.ts";
import { buildRemoteInfo, isLoopbackHost } from "../rpc/remote.ts";
import { RotatingLog, teeConsole } from "./logFile.ts";
import { clearRuntime, writeRuntime } from "./runtime.ts";

export interface BannerInput {
  environmentId: string;
  name: string;
  version: string;
  host: string;
  port: number;
  /** http base URLs other machines can use (empty on a loopback bind) */
  lanUrls: string[];
  providers: string[];
  pairing?: { code: string; expiresAt: number };
  token?: string;
  webDir?: string;
  logPath?: string;
}

/** What `tide serve` prints once it listens. Pure so the wording is tested. */
export function serveBanner(b: BannerInput): string {
  const lines = [
    `tide-server ${b.version} — "${b.name}" (env ${b.environmentId})`,
    `  listening on ${b.host}:${b.port}  (ws://127.0.0.1:${b.port}/ws on this machine)`,
  ];
  if (b.lanUrls.length > 0) for (const url of b.lanUrls) lines.push(`  reachable at ${url}`);
  else if (isLoopbackHost(b.host)) lines.push("  loopback only: other machines cannot connect (use --host 0.0.0.0)");
  lines.push(`  harnesses: ${b.providers.join(", ") || "none"}`);
  lines.push(`  web client: ${b.webDir ?? "not bundled (/ shows pairing instructions)"}`);
  if (b.logPath !== undefined) lines.push(`  log: ${b.logPath}`);
  if (b.token !== undefined) lines.push(`  token: ${b.token}`);
  if (b.pairing !== undefined) {
    const minutes = Math.max(1, Math.round((b.pairing.expiresAt - Date.now()) / 60_000));
    lines.push("", `  pairing code: ${b.pairing.code}  (single use, expires in ${minutes} min)`);
    lines.push("  Add this machine in a Tide client (Environments → Add) with one of the URLs above and the code.");
    lines.push("  Run `tide pair` any time for a fresh code and a QR.");
  }
  return lines.join("\n");
}

/** `tide serve` and the legacy no-subcommand form (desktop sidecar, `pnpm dev`). */
export async function runServe(args: string[], legacy: boolean): Promise<void> {
  const flags = parseArgs(args);
  const logPath = flags.log !== undefined ? resolve(flags.log) : undefined;
  if (logPath !== undefined) {
    teeConsole(new RotatingLog(logPath));
    // a service's stderr goes nowhere: the crash that ends the process must reach the log file
    process.on("uncaughtException", (err) => {
      console.error("[fatal] uncaught exception", err);
      process.exit(1);
    });
  }
  const config = resolveConfig(args, process.env, { defaultHost: legacy ? "127.0.0.1" : "0.0.0.0" });

  const app = await createApp({ config });
  if (flags.name !== undefined && flags.name.trim().length > 0) app.settings.set({ environment: { name: flags.name.trim().slice(0, 64) } });
  const port = app.server?.port ?? config.port;
  writeRuntime(config.tideHome, { pid: process.pid, host: config.host, port, startedAt: Date.now() });

  const name = app.settings.get().environment.name;
  if (legacy) {
    console.log(`tide-server listening on ws://${config.host}:${port}/ws (env ${app.environmentId}, "${name}")`);
    console.log(`  health: http://${config.host}:${port}/health`);
    console.log(`  providers: ${app.registry.list().join(", ") || "none"}`);
    if (config.dev || config.printToken) console.log(`  token: ${config.token}`);
  } else {
    const remote = buildRemoteInfo({ host: config.host, port, token: config.token, includePairing: false });
    console.log(
      serveBanner({
        environmentId: app.environmentId,
        name,
        version: config.version,
        host: config.host,
        port,
        lanUrls: remote.lanUrls.length > 0 ? pairingUrls(remote, undefined) : [],
        providers: app.registry.list(),
        pairing: app.pairing.issue(),
        ...(config.dev || config.printToken ? { token: config.token } : {}),
        ...(config.webDir !== undefined ? { webDir: config.webDir } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
      }),
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\ntide-server shutting down (${signal})`);
    clearRuntime(config.tideHome);
    void app
      .close()
      .catch((err: unknown) => console.error("[shutdown] failed", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
