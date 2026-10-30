import { spawn } from "node:child_process";
import type { DriverEnv, McpServerSpec } from "@tide/contracts";
import type { AcpConfig, ChildLike, SpawnLike } from "./types.ts";

/**
 * Environment for one agent process: the server's own, then the instance's (registry account
 * env), then the config's, then the session's. `HOME` moves only when a home is configured.
 */
export function agentEnv(config: AcpConfig, env: DriverEnv, sessionEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const home = config.home ?? env.instance?.home;
  return {
    ...process.env,
    ...env.instance?.env,
    ...config.env,
    ...sessionEnv,
    ...(home !== undefined && home !== "" ? { HOME: home } : {}),
  };
}

/** ACP's stdio MCP server shape: `env` is an array of `{name, value}`, `args` always present. */
export function toAcpMcpServers(servers: McpServerSpec[]): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  }));
}

/**
 * node's `spawn` in its own process group, so `kill` reaches the whole tree: registry agents
 * are usually `npx … --acp`, where the real agent is a grandchild of the spawned process.
 */
export const nodeSpawn: SpawnLike = (command, args, options) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const like: ChildLike = {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal?: NodeJS.Signals) {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal ?? "SIGTERM");
          return true;
        } catch {
          // the group is gone or was never created; fall back to the direct child
        }
      }
      return child.kill(signal);
    },
    once(event, listener) {
      child.once(event, listener as (...args: unknown[]) => void);
      return like;
    },
  };
  return like;
};
