import { execFile } from "node:child_process";
import { parsePs } from "../ports.ts";

export type TreeSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface KillTreeDeps {
  /** `process.kill`; a negative pid addresses the process group */
  kill?: (pid: number, signal: TreeSignal) => void;
  /** `ps -axo pid=,ppid=` output, undefined when ps is unavailable */
  ps?: () => Promise<string | undefined>;
}

const systemPs = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) =>
      resolve(err === null || stdout.length > 0 ? stdout : undefined),
    );
  });

/** Descendants of `root`, deepest first (children are signalled before their parents). */
export function descendants(root: number, parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  const order: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const child of children.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      order.push(child);
      queue.push(child);
    }
  }
  return order.reverse();
}

/**
 * Signals a terminal's whole process tree. The shell is a session leader under node-pty's fork helper
 * and Bun's `terminal`, so `kill(-pid)` reaches its process group. An interactive shell with job
 * control puts each foreground job in a group of its own, though, so the descendants found by a `ps`
 * walk are signalled one by one as well (children first, then the shell). The group kill failing with
 * ESRCH/EPERM is not an error: the walk covers it.
 */
export async function killProcessTree(pid: number, signal: TreeSignal, deps: KillTreeDeps = {}): Promise<void> {
  const kill = deps.kill ?? ((target: number, sig: TreeSignal) => process.kill(target, sig));
  const tryKill = (target: number): void => {
    try {
      kill(target, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw err;
    }
  };
  tryKill(-pid);
  const text = await (deps.ps ?? systemPs)();
  const tree = text === undefined ? [] : descendants(pid, parsePs(text));
  for (const child of tree) tryKill(child);
  tryKill(pid);
}

/** Live descendants of `pid` (empty when ps is unavailable: the caller then hangs the shell up). */
export async function childPids(pid: number, ps: () => Promise<string | undefined> = systemPs): Promise<number[]> {
  const text = await ps();
  return text === undefined ? [] : descendants(pid, parsePs(text));
}
