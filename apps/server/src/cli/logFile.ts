import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

export function defaultLogPath(tideHome: string): string {
  return join(tideHome, "logs", "server.log");
}

/**
 * Append-only log with size rotation: `server.log` → `server.log.1` → … → `server.log.<keep-1>`,
 * so at most `keep` files of `maxBytes` each. Same scheme as the desktop shell's process.rs.
 * Writes are synchronous: a crash must not lose the line that explains it.
 */
export class RotatingLog {
  readonly path: string;
  #maxBytes: number;
  #keep: number;
  #size: number;

  constructor(path: string, options: { maxBytes?: number; keep?: number } = {}) {
    this.path = path;
    this.#maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.#keep = options.keep ?? LOG_KEEP;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#size = existsSync(path) ? statSync(path).size : 0;
  }

  write(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
      this.#size += bytes;
    } catch {
      // a full disk must not take the server down with it
    }
  }

  #rotate(): void {
    try {
      rmSync(`${this.path}.${this.#keep - 1}`, { force: true });
      for (let i = this.#keep - 2; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      if (this.#keep > 1) renameSync(this.path, `${this.path}.1`);
      else rmSync(this.path, { force: true });
    } catch {
      // rotation is best effort
    }
    this.#size = 0;
  }
}

type ConsoleMethod = "log" | "info" | "warn" | "error";

/** Mirrors console output into `log` (timestamped); returns the undo. */
export function teeConsole(log: RotatingLog, now: () => Date = () => new Date()): () => void {
  const methods: ConsoleMethod[] = ["log", "info", "warn", "error"];
  const originals = methods.map((m) => console[m]);
  methods.forEach((method, i) => {
    const original = originals[i] as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void => {
      original.apply(console, args);
      log.write(`${now().toISOString()} ${method === "log" || method === "info" ? "INFO " : method.toUpperCase().padEnd(5)} ${format(...args)}\n`);
    };
  });
  return () => methods.forEach((method, i) => (console[method] = originals[i] as (typeof console)[ConsoleMethod]));
}
