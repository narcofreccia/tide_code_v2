/** How a terminal died. `signal` is a name or number rendered as a string. */
export interface PtyExit {
  code?: number;
  signal?: string;
}

export interface PtySpawnSpec {
  /** shell executable */
  file: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/** One live terminal, normalized across backends. Data is already decoded to utf-8. */
export interface PtyHandle {
  onData(cb: (data: string) => void): void;
  onExit(cb: (exit: PtyExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** signals the shell's process group and every descendant (see killTree.ts) */
  killTree(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void>;
  /** OS pid of the shell, when the backend knows it (ports.list walks its descendants) */
  pid?: number | undefined;
}

/**
 * A pty implementation. `node-pty` under Node; `Bun.spawn({ terminal })` under Bun, where
 * the native module cannot be embedded in the compiled sidecar.
 */
export interface PtyBackend {
  readonly name: "node-pty" | "bun";
  spawn(spec: PtySpawnSpec): PtyHandle;
}

export interface PtyInfo {
  ptyId: string;
  title?: string;
  alive: boolean;
  /** the run-stack service name for `run:` terminals */
  label?: string;
}
