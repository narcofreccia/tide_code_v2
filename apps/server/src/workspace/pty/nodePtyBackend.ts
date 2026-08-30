import { accessSync, chmodSync, constants as FS } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PtyBackend, PtyHandle, PtySpawnSpec } from "./types.ts";

// Minimal structural view of node-pty; the real types live behind an optional native module.
interface NodePtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
  ): NodePtyProcess;
}

let cached: Promise<PtyBackend> | undefined;

/**
 * node-pty is the one native dependency in the Node server process. A missing or
 * mismatched prebuild must degrade to an `unavailable` error rather than kill the process
 * at boot, so the import happens on first use and the failure is cached-and-cleared.
 */
export function createNodePtyBackend(): Promise<PtyBackend> {
  cached ??= (async () => {
    const mod = (await import("node-pty")) as unknown as { default?: NodePtyModule; spawn?: NodePtyModule["spawn"] };
    const resolved = typeof mod.spawn === "function" ? (mod as unknown as NodePtyModule) : mod.default;
    if (resolved === undefined || typeof resolved.spawn !== "function") throw new Error("node-pty has no spawn()");
    ensureSpawnHelperExecutable();
    return backendFrom(resolved);
  })().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

function backendFrom(mod: NodePtyModule): PtyBackend {
  return {
    name: "node-pty",
    spawn(spec: PtySpawnSpec): PtyHandle {
      const proc = mod.spawn(spec.file, [], {
        name: "xterm-256color",
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
        env: spec.env,
      });
      return {
        onData: (cb) => proc.onData(cb),
        onExit: (cb) =>
          proc.onExit(({ exitCode, signal }) =>
            cb({
              ...(typeof exitCode === "number" ? { code: exitCode } : {}),
              ...(signal !== undefined && signal !== 0 ? { signal: String(signal) } : {}),
            }),
          ),
        write: (data) => proc.write(data),
        resize: (cols, rows) => proc.resize(cols, rows),
        kill: () => proc.kill(),
      };
    },
  };
}

/**
 * Some package managers drop the exec bit when extracting node-pty's prebuilt
 * `spawn-helper`, which makes every fork fail with "posix_spawnp failed". Restore it.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    try {
      accessSync(helper, FS.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch {
    // built from source (build/Release) or genuinely missing: spawn will report it
  }
}
