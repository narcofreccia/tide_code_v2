import type { PtyBackend, PtyExit, PtyHandle, PtySpawnSpec } from "./types.ts";

// Bun's own globals are not in @types/node; this is the declared boundary for them.
interface BunTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close?(): void;
}
interface BunSubprocess {
  terminal?: BunTerminal;
  exited: Promise<number>;
  signalCode?: string | null;
  kill(signal?: number | string): void;
}
interface BunGlobal {
  spawn(
    cmd: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      terminal: { cols: number; rows: number; data(term: unknown, chunk: Uint8Array): void };
    },
  ): BunSubprocess;
}

const bunGlobal = (): BunGlobal | undefined => (globalThis as { Bun?: BunGlobal }).Bun;

/**
 * True when this process is Bun on a platform whose pty support exists. Bun ≥ 1.3.5 has
 * no terminal option on Windows, so Windows always falls through to node-pty.
 */
export function isBunRuntime(): boolean {
  return bunGlobal() !== undefined && process.platform !== "win32";
}

/**
 * Bun.spawn's `terminal` option, used by the compiled desktop sidecar where the native
 * node-pty module cannot be embedded. Output arrives as bytes, so the decoder is
 * streaming: a multi-byte character split across two chunks must not become U+FFFD.
 */
export function createBunBackend(): PtyBackend {
  const Bun = bunGlobal();
  if (Bun === undefined) throw new Error("Bun global is not available");
  return {
    name: "bun",
    spawn(spec: PtySpawnSpec): PtyHandle {
      const decoder = new TextDecoder("utf-8");
      let onData: (data: string) => void = () => undefined;
      const proc = Bun.spawn([spec.file], {
        cwd: spec.cwd,
        env: spec.env,
        terminal: {
          cols: spec.cols,
          rows: spec.rows,
          data: (_term, chunk) => onData(decoder.decode(chunk, { stream: true })),
        },
      });
      const terminal = proc.terminal;
      if (terminal === undefined) throw new Error("Bun.spawn returned no terminal");

      let onExit: (exit: PtyExit) => void = () => undefined;
      void proc.exited.then((code) => {
        const signal = proc.signalCode;
        onExit({
          ...(typeof code === "number" ? { code } : {}),
          ...(signal !== undefined && signal !== null ? { signal } : {}),
        });
      });

      return {
        onData: (cb) => {
          onData = cb;
        },
        onExit: (cb) => {
          onExit = cb;
        },
        write: (data) => terminal.write(data),
        resize: (cols, rows) => terminal.resize(cols, rows),
        kill: () => proc.kill(),
      };
    },
  };
}
