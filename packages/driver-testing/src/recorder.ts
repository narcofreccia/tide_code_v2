import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeFrames, type Frame, type StartFrame } from "./frames.ts";

export type StartInfo = Pick<StartFrame, "provider" | "version" | "scenario" | "synthetic"> & Record<string, unknown>;

/**
 * Collects the traffic between a real driver and a real harness as a transcript. The shape
 * wrappers (`recordSpawn`, `recordFetch`, `recordQuery`) feed it; nothing here knows a protocol.
 */
export class Recorder {
  readonly start: StartFrame;
  readonly frames: Frame[] = [];
  #processes = 0;
  #redact: boolean;

  /** `redact` (default on) masks values under secret-looking keys: `"$any"` outbound, `"[redacted]"` inbound */
  constructor(start: StartInfo, options: { redact?: boolean } = {}) {
    this.start = { ...start, t: "start" } as StartFrame;
    this.#redact = options.redact ?? true;
    this.frames.push(this.start);
  }

  /** A new process / connection begins; the first one is implicit. */
  proc(name?: string): void {
    if (this.#processes++ > 0) this.frames.push({ t: "proc", ...(name !== undefined ? { name } : {}) });
    else if (name !== undefined) this.frames.push({ t: "proc", name });
  }

  out(frame: unknown): void {
    this.frames.push({ t: "expect_out", match: this.#redact ? redact(frame, "$any") : frame });
  }

  in(frame: unknown): void {
    this.frames.push({ t: "in", frame: this.#redact ? redact(frame, "[redacted]") : frame });
  }

  exit(code: number | null): void {
    this.frames.push({ t: "exit", code });
  }

  toString(): string {
    return serializeFrames(this.frames);
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.toString());
  }
}

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|credential|email/i;

/** Masks the value of every secret-looking key, deeply. Review recorded files before committing anyway. */
export function redact(value: unknown, mask: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, mask));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) && typeof item === "string" ? mask : redact(item, mask)]));
  }
  return value;
}

/** JSON-safe copy: functions and symbols become markers, cycles are cut. */
export function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "function") return "[function]";
      if (typeof item === "symbol") return item.toString();
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    }) ?? "null",
  );
}
