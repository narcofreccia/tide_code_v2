import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRuntime, tideHomeOf } from "./runtime.ts";

export class TokenError extends Error {
  override name = "TokenError";
}

export interface RotateOptions {
  env?: NodeJS.ProcessEnv;
  /** tests: a deterministic token */
  random?: () => string;
  /** tests: whether a pid is alive */
  alive?: (pid: number) => boolean;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * `tide token rotate`: a new master token in `<TIDE_HOME>/server.json`, every other field kept,
 * written 0600 through a temp file and a rename (a crash never leaves a half-written identity).
 * A running server keeps the old token in memory until it restarts; nothing is hot-swapped.
 */
export function rotateToken(options: RotateOptions = {}): string {
  const tideHome = tideHomeOf(options.env);
  const file = join(tideHome, "server.json");
  let identity: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as Record<string, unknown>)["token"] !== "string") throw new Error("no token field");
    identity = parsed as Record<string, unknown>;
  } catch (err) {
    throw new TokenError(`cannot read the identity in ${file} (${err instanceof Error ? err.message : String(err)}); start the server once to create it`);
  }
  identity["token"] = (options.random ?? (() => randomBytes(32).toString("hex")))();
  const tmp = `${file}.tmp`;
  try {
    rmSync(tmp, { force: true }); // a leftover temp file would keep its own mode
    writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new TokenError(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const runtime = readRuntime(tideHome);
  const running = runtime !== undefined && (options.alive ?? pidAlive)(runtime.pid);
  return [
    `New master token written to ${file}.`,
    "",
    running
      ? `The server running on port ${runtime.port} (pid ${runtime.pid}) still uses the old token until it restarts: restart it now (quit and reopen the desktop app, stop and rerun \`tide serve\`, or restart the service: \`launchctl kickstart -k gui/$(id -u)/com.tide.server\` on macOS, \`systemctl --user restart tide-server\` on Linux).`
      : "No running server found for this TIDE_HOME; the next start uses the new token.",
    "",
    "After the restart:",
    "  - the desktop app reads the token from server.json when it starts: nothing to do;",
    "  - devices paired with a pairing code hold their own device token and keep working;",
    "  - devices that hold the old master token (paired before per-device tokens, or given the token by hand) must pair again (`tide pair`).",
  ].join("\n");
}
