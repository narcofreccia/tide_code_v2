import { parseArgs as parseServerFlags } from "../config.ts";

export type CliCommand =
  | { cmd: "mcp" }
  | { cmd: "version" }
  | { cmd: "help" }
  /** `legacy`: no subcommand (the desktop sidecar and `pnpm dev`): loopback by default */
  | { cmd: "serve"; args: string[]; legacy: boolean }
  | { cmd: "pair"; port?: number; host?: string; qr: boolean }
  | { cmd: "doctor"; port?: number }
  | { cmd: "service"; action: "install" | "uninstall" | "status"; serveArgs: string[] };

export class CliError extends Error {}

export const USAGE = `usage:
  tide serve [--host 0.0.0.0] [--port 3777] [--data <dir>] [--name <machine name>] [--web <dir>] [--log <file>]
             run the server headless (all interfaces by default) and print a pairing code
  tide pair [--port <n>] [--host <h>] [--no-qr]
             ask the running server for a one-time pairing code (6 digits, 5 minutes)
  tide doctor [--port <n>]
             check node, git/gh/rg, harness CLIs, TIDE_HOME, the port and server.json
  tide service install [serve flags] | uninstall | status
             run \`tide serve\` at login (launchd on macOS, systemd --user on Linux)
  tide --version
  tide --mcp  (internal: the Tide MCP stdio server)

TIDE_HOME (default ~/.tide) holds server.json (identity + token), settings, data and logs.`;

function portOf(value: string | undefined, flag: string): number {
  const port = Number(value);
  if (value === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError(`${flag} needs a port number`);
  return port;
}

/** Pure: argv (after the binary) → what to run. Server flags are validated by config's parser. */
export function parseCli(argv: string[]): CliCommand {
  if (argv.includes("--mcp")) return { cmd: "mcp" };
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v" || first === "version") return { cmd: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { cmd: "help" };
  const validate = (args: string[]): string[] => {
    try {
      parseServerFlags(args);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (VALUE_FLAGS.has(arg)) i++;
      else if (!arg.startsWith("--")) throw new CliError(`unexpected argument ${arg}`);
    }
    return args;
  };
  switch (first) {
    case undefined:
      return { cmd: "serve", args: [], legacy: true };
    case "serve":
      return { cmd: "serve", args: validate(rest), legacy: false };
    case "pair": {
      const out: { cmd: "pair"; port?: number; host?: string; qr: boolean } = { cmd: "pair", qr: true };
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--port") out.port = portOf(rest[++i], "--port");
        else if (arg === "--host") {
          const host = rest[++i];
          if (host === undefined) throw new CliError("--host needs a value");
          out.host = host;
        } else if (arg === "--no-qr") out.qr = false;
        else throw new CliError(`unknown argument ${String(arg)} for tide pair`);
      }
      return out;
    }
    case "doctor": {
      if (rest.length === 0) return { cmd: "doctor" };
      if (rest[0] === "--port" && rest.length === 2) return { cmd: "doctor", port: portOf(rest[1], "--port") };
      throw new CliError(`unknown argument ${String(rest[0])} for tide doctor`);
    }
    case "service": {
      const [action, ...serveArgs] = rest;
      if (action !== "install" && action !== "uninstall" && action !== "status") throw new CliError("tide service install|uninstall|status");
      if (action !== "install" && serveArgs.length > 0) throw new CliError(`tide service ${action} takes no arguments`);
      if (serveArgs.includes("--log") || serveArgs.includes("--dev")) throw new CliError("a service always logs to <TIDE_HOME>/logs/server.log and never runs in --dev");
      return { cmd: "service", action, serveArgs: validate(serveArgs) };
    }
    default:
      // flags without a subcommand: the original `tide-server --port … --host …` form
      if (first.startsWith("--")) return { cmd: "serve", args: validate(argv), legacy: true };
      throw new CliError(`unknown command ${first}`);
  }
}

const VALUE_FLAGS = new Set(["--port", "--host", "--data", "--name", "--web", "--log"]);

