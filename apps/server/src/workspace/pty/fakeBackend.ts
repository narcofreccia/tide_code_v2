import type { TreeSignal } from "./killTree.ts";
import type { PtyBackend, PtyExit, PtyHandle, PtySpawnSpec } from "./types.ts";

/** Test support: one terminal of the fake backend, driven by the test instead of a process. */
export interface FakePty {
  spec: PtySpawnSpec;
  pid: number;
  data(chunk: string): void;
  exit(code: number, signal?: string): void;
  written: string[];
  resized: [number, number][];
  killed: number;
  /** signals received through killTree, in order */
  signals: TreeSignal[];
  /** the signals this terminal dies on (default: SIGKILL only) */
  diesOn: Set<TreeSignal>;
}

/** A PtyBackend whose terminals are driven by the test rather than by a real process. */
export function fakeBackend(options: { firstPid?: number } = {}): { backend: PtyBackend; handles: FakePty[] } {
  const handles: FakePty[] = [];
  let nextPid = options.firstPid ?? 1000;
  const backend: PtyBackend = {
    name: "node-pty",
    spawn(spec: PtySpawnSpec): PtyHandle {
      let onData: (d: string) => void = () => undefined;
      let onExit: (e: PtyExit) => void = () => undefined;
      let alive = true;
      const exit = (e: PtyExit): void => {
        if (!alive) return;
        alive = false;
        onExit(e);
      };
      const handle: FakePty = {
        spec,
        pid: nextPid++,
        data: (chunk) => onData(chunk),
        exit: (code, signal) => exit({ code, ...(signal !== undefined ? { signal } : {}) }),
        written: [],
        resized: [],
        killed: 0,
        signals: [],
        diesOn: new Set(["SIGKILL"]),
      };
      handles.push(handle);
      return {
        pid: handle.pid,
        onData: (cb) => {
          onData = cb;
        },
        onExit: (cb) => {
          onExit = cb;
        },
        write: (data) => handle.written.push(data),
        resize: (cols, rows) => handle.resized.push([cols, rows]),
        kill: () => {
          handle.killed++;
          exit({ code: 143, signal: "SIGTERM" });
        },
        killTree: async (signal) => {
          handle.signals.push(signal);
          if (handle.diesOn.has(signal)) exit({ signal });
        },
      };
    },
  };
  return { backend, handles };
}
