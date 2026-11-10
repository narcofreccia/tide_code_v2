import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starting and stopping the scratch tide-server. Global setup boots it once; the reconnect step
 * kills it and boots it again on the same port and home. The live pid is kept in `state.json`
 * so global teardown kills whichever process is running at the end.
 */

export const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(E2E_ROOT, "..", "..");
export const SERVER_BIN = join(REPO_ROOT, "apps", "server", "src", "bin.ts");
export const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");

/** What global setup hands to the spec (through `TIDE_E2E_STATE`, a JSON file path). */
export interface E2EState {
  /** temp root; everything below is removed by teardown */
  root: string;
  tideHome: string;
  /** HOME for the server and the agent: no harness logins, no user git config */
  home: string;
  /** the throwaway git repo added as a project */
  repo: string;
  port: number;
  token: string;
  /** PATH the server runs with: node and git only */
  path: string;
  serverPid?: number;
}

export function readState(): E2EState {
  const file = process.env["TIDE_E2E_STATE"];
  if (file === undefined || !existsSync(file)) throw new Error("TIDE_E2E_STATE is not set: run through `pnpm e2e` (global setup writes it)");
  return JSON.parse(readFileSync(file, "utf8")) as E2EState;
}

export function writeState(file: string, state: E2EState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/**
 * The server's environment is built from scratch rather than inherited: HOME points at an empty
 * dir and PATH holds only node and git, so the bundled harnesses (claude, codex, opencode, pi)
 * find neither a CLI nor a login and no real model is ever called.
 */
function serverEnv(state: E2EState): NodeJS.ProcessEnv {
  return {
    HOME: state.home,
    PATH: state.path,
    TIDE_HOME: state.tideHome,
    TMPDIR: join(state.root, "tmp"),
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Boots `tide serve` from source and resolves once it prints its banner. */
export function startServer(state: E2EState): Promise<ChildProcess> {
  const log = createWriteStream(join(state.root, "server.log"), { flags: "a" });
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", SERVER_BIN, "serve", "--host", "127.0.0.1", "--port", String(state.port), "--web", WEB_DIST, "--name", "e2e"],
    { cwd: state.root, env: serverEnv(state), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  return new Promise((done, fail) => {
    let seen = "";
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      if (seen.includes("listening on")) {
        child.stdout?.off("data", onData);
        done(child);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => fail(new Error(`tide-server exited before listening (code ${code}, signal ${signal}); see ${join(state.root, "server.log")}\n${seen}`)));
  });
}

/** Kills the server and resolves once the process is gone. */
export function stopServer(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill(signal);
  });
}
