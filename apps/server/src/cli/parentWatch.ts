import { pidAlive } from "../homeLock.ts";

/**
 * The desktop shell sets `TIDE_PARENT_PID` on the sidecar. A shell that dies without a
 * graceful stop (SIGKILL, crash, `cargo tauri dev` rebuild) runs none of its cleanup, so the
 * server watches the parent itself and shuts down when it is gone.
 */
export const PARENT_PID_ENV = "TIDE_PARENT_PID";

export interface ParentWatchDeps {
  /** true while the pid exists */
  alive(pid: number): boolean;
  /** the current parent pid; read live under node, cached at start under bun (re-parenting then goes unseen) */
  ppid(): number;
  /** schedules `fn` every `ms`; returns a stop function. Production uses an unref'd setInterval. */
  every(fn: () => void, ms: number): () => void;
}

export const PARENT_POLL_MS = 2_000;

/** Parses the env value; anything but a positive integer other than our own pid means "not supervised". */
export function parentPidFrom(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[PARENT_PID_ENV];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const pid = Number(raw.trim());
  return pid > 1 && pid !== process.pid ? pid : undefined;
}

/**
 * Calls `onGone` once when `parentPid` disappears: the pid no longer exists, or we were the
 * parent's direct child and have been re-parented (which also catches a recycled pid).
 */
export function watchParent(parentPid: number, onGone: (reason: string) => void, deps: ParentWatchDeps = hostDeps(), ms = PARENT_POLL_MS): () => void {
  const direct = deps.ppid() === parentPid;
  let done = false;
  const stop = deps.every(() => {
    if (done) return;
    let reason: string | undefined;
    if (!deps.alive(parentPid)) reason = `parent process ${parentPid} exited`;
    else if (direct && deps.ppid() !== parentPid) reason = `re-parented away from ${parentPid}`;
    if (reason === undefined) return;
    done = true;
    stop();
    onGone(reason);
  }, ms);
  return () => {
    done = true;
    stop();
  };
}

function hostDeps(): ParentWatchDeps {
  return {
    alive: pidAlive,
    ppid: () => process.ppid,
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
