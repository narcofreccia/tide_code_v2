import { StringDecoder } from "node:string_decoder";
import type { ChildLike, PiLine, PiResponse } from "./types.ts";

/**
 * NDJSON transport for `pi --mode rpc`.
 *
 * docs/rpc.md is explicit: strict JSONL, LF is the ONLY record delimiter, a trailing `\r`
 * is stripped, and generic line readers that split on Unicode separators are wrong. Every
 * command carries an `id`; the matching `{"type":"response","id":...}` resolves it. Anything
 * else — agent events, `extension_ui_request`, responses we never asked for — is handed to
 * `onLine` untouched (CLAUDE.md §1a "pass through, don't translate").
 */

export function splitJsonl(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n");
    if (index === -1) return rest;
    let line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() !== "") onLine(line);
  }
}

export function readJsonl(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    buffer = splitJsonl(buffer, onLine);
  });
  stream.on("end", () => {
    buffer += decoder.end();
    splitJsonl(`${buffer}\n`, onLine);
    buffer = "";
  });
}

export interface PiRpcOptions {
  onLine: (line: PiLine) => void;
  log: (message: string, data?: unknown) => void;
}

export class PiRpc {
  #child: ChildLike;
  #options: PiRpcOptions;
  #pending = new Map<string, { resolve: (value: PiResponse) => void; reject: (error: Error) => void }>();
  #counter = 0;
  #exited: Error | undefined;

  constructor(child: ChildLike, options: PiRpcOptions) {
    this.#child = child;
    this.#options = options;
    if (child.stdout) readJsonl(child.stdout, (line) => this.#handle(line));
    if (child.stderr) readJsonl(child.stderr, (line) => options.log(`[pi:stderr] ${line}`));
    child.once("exit", ((code: number | null) => this.#fail(new Error(`pi exited with code ${code ?? "null"}`))) as never);
    child.once("error", ((error: Error) => this.#fail(error)) as never);
  }

  #handle(raw: string): void {
    let line: PiLine;
    try {
      line = JSON.parse(raw) as PiLine;
    } catch {
      this.#options.log(`[pi] unparseable line: ${raw.slice(0, 200)}`);
      return;
    }
    if (line.type === "response") {
      const response = line as PiResponse;
      const id = response.id;
      const waiter = id === undefined ? undefined : this.#pending.get(id);
      if (waiter && id !== undefined) {
        this.#pending.delete(id);
        waiter.resolve(response);
        return;
      }
    }
    this.#options.onLine(line);
  }

  #fail(error: Error): void {
    this.#exited ??= error;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
  }

  /** Fire-and-forget; used for `extension_ui_response`, which pi never answers. */
  notify(command: Record<string, unknown>): void {
    if (this.#exited) return;
    this.#child.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  /** Sends a command with a fresh `id` and resolves on the matching `response`. */
  request(command: Record<string, unknown>): Promise<PiResponse> {
    if (this.#exited) return Promise.reject(this.#exited);
    this.#counter += 1;
    const id = `tide-${this.#counter}`;
    const promise = new Promise<PiResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
    return promise;
  }

  /** `request` that returns `data` on success and undefined on any failure. */
  async data<T>(command: Record<string, unknown>): Promise<T | undefined> {
    try {
      const response = await this.request(command);
      return response.success ? (response.data as T) : undefined;
    } catch (error) {
      this.#options.log(`[pi] ${String(command["type"])} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  close(): void {
    this.#fail(this.#exited ?? new Error("pi session closed"));
    try {
      this.#child.stdin?.end();
    } catch {
      // a closed pipe is fine
    }
    try {
      this.#child.kill();
    } catch {
      // already gone
    }
  }
}
