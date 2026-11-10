import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_ROOT, REPO_ROOT, WEB_DIST, freePort, readState, startServer, stopServer, writeState, type E2EState } from "./fixtures/server.ts";
import { OLD_CONTENT } from "./fixtures/script.ts";

/**
 * One scratch world per run: a temp git repo with one commit, a TIDE_HOME whose settings add
 * the scripted ACP agent, an empty HOME, and tide-server serving the built web client on a free
 * loopback port. The real ~/.tide and ports 3777/5173 are never touched.
 */

const TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(entry.parentPath, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** Builds apps/web when dist is missing or older than the web/client/contracts sources. */
function ensureWebBuild(): void {
  const index = join(WEB_DIST, "index.html");
  const sources = [join(REPO_ROOT, "apps", "web", "src"), join(REPO_ROOT, "apps", "web", "index.html"), join(REPO_ROOT, "packages", "client", "src"), join(REPO_ROOT, "packages", "contracts", "src")];
  const newest = Math.max(...sources.map((path) => (statSync(path).isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)));
  if (existsSync(index) && statSync(index).mtimeMs >= newest) return;
  console.log("[e2e] apps/web/dist is missing or stale: building the web client");
  execFileSync("pnpm", ["--filter", "@tide/web", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}

function git(cwd: string, home: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
}

function which(name: string): string {
  return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  ensureWebBuild();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tide-e2e-")));
  const home = join(root, "home");
  const tideHome = join(root, "tide-home");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  for (const dir of [home, tideHome, repo, bin, join(root, "tmp")]) mkdirSync(dir, { recursive: true });

  // node and git are all the server needs on PATH; no harness CLI is reachable
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(which("git"), join(bin, "git"));
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Tide E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n");

  writeFileSync(join(repo, "hello.txt"), OLD_CONTENT);
  writeFileSync(join(repo, "README.md"), "# e2e repo\n");
  git(repo, home, "init", "-q", "-b", "main");
  git(repo, home, "add", ".");
  git(repo, home, "commit", "-qm", "initial commit");

  writeFileSync(join(tideHome, "server.json"), `${JSON.stringify({ environmentId: "e2e-env", token: TOKEN, providers: {} }, null, 2)}\n`, { mode: 0o600 });
  const fakeAgent = join(E2E_ROOT, "fixtures", "fake-agent.ts");
  const settings = {
    providerDefaults: {},
    worktreeByDefault: true,
    decisions: { enabled: false },
    // commit messages would ask a harness for text: keep every model call out of the run
    git: { generateMessages: false },
    providerInstances: [
      { id: "acp:e2e", kind: "acp", label: "E2E Agent", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", fakeAgent] },
    ],
  };
  writeFileSync(join(tideHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  const state: E2EState = { root, tideHome, home, repo, port: await freePort(), token: TOKEN, path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const stateFile = join(root, "state.json");
  const server = await startServer(state);
  writeState(stateFile, { ...state, ...(server.pid !== undefined ? { serverPid: server.pid } : {}) });
  process.env["TIDE_E2E_STATE"] = stateFile;
  console.log(`[e2e] tide-server on http://127.0.0.1:${state.port} (home ${root}); log: ${join(root, "server.log")}`);

  return async () => {
    await stopServer(server);
    // the reconnect step restarts the server from the worker, whose afterAll stops it; this is
    // the backstop for a worker that died before it could
    const pid = readState().serverPid;
    if (pid !== undefined && pid !== server.pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (process.env["TIDE_E2E_KEEP"] === "1") console.log(`[e2e] TIDE_E2E_KEEP=1: leaving ${root}`);
    else rmSync(root, { recursive: true, force: true });
  };
}
