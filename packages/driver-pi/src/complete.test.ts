import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CompletionRequest } from "@tide/contracts";
import { createPiInstance } from "./index.ts";
import { PI_CAPS } from "./status.ts";
import type { ChildLike, PiConfig } from "./types.ts";

interface Fake extends ChildLike {
  written: string;
  ended: boolean;
  signals: (NodeJS.Signals | undefined)[];
  out: PassThrough;
  err: PassThrough;
  exit(code: number | null): void;
}

function fake(): Fake {
  const out = new PassThrough();
  const err = new PassThrough();
  const emitter = new EventEmitter();
  const f: Fake = {
    written: "",
    ended: false,
    signals: [],
    out,
    err,
    stdout: out,
    stderr: err,
    stdin: {
      write(chunk: string) {
        f.written += chunk;
        return true;
      },
      end() {
        f.ended = true;
      },
    },
    kill(signal) {
      f.signals.push(signal);
      return true;
    },
    once(event, listener) {
      emitter.once(event, listener as (...args: unknown[]) => void);
      return f;
    },
    exit(code) {
      emitter.emit("exit", code);
    },
  };
  return f;
}

function setup() {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const children: Fake[] = [];
  const instance = createPiInstance({ binaryPath: process.execPath } as PiConfig, { dataDir: tmpdir(), log: () => undefined }, {
    probe: async () => "1.1.0",
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const child = fake();
      children.push(child);
      return child;
    },
    fetch: async () => ({ ok: false, json: async () => undefined }),
  });
  return { instance, calls, children };
}

const request = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "Answer with one word.",
  prompt: "Is the sky blue?",
  timeoutMs: 60_000,
  cwd: tmpdir(),
  ...over,
});

const spawned = async (children: Fake[]): Promise<Fake> => {
  while (children.length === 0) await new Promise((resolve) => setImmediate(resolve));
  return children[0]!;
};

describe("pi complete()", () => {
  it("advertises oneShot", () => {
    expect(PI_CAPS.oneShot).toBe(true);
  });

  it("spawns pi tools-off, sends the prompt on stdin and returns trimmed stdout", async () => {
    const { instance, calls, children } = setup();
    const done = instance.complete!(request({ model: "anthropic/haiku" }));
    const child = await spawned(children);
    child.out.write("  yes\n");
    child.exit(0);
    const result = await done;
    expect(result.text).toBe("yes");
    expect(result.model).toBe("anthropic/haiku");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--thinking", "off", "--model", "anthropic/haiku", "--system-prompt", "Answer with one word."]),
    );
    expect(calls[0]!.cwd).toBe(tmpdir());
    expect(child.written).toBe("Is the sky blue?");
    expect(child.ended).toBe(true);
  });

  it("matches labels case-insensitively", async () => {
    const { instance, children } = setup();
    const done = instance.complete!(request({ labels: ["Approve", "Reject"] }));
    const child = await spawned(children);
    child.out.write("approve\n");
    child.exit(0);
    expect((await done).label).toBe("Approve");
  });

  it("leaves label unset when the answer matches none", async () => {
    const { instance, children } = setup();
    const done = instance.complete!(request({ labels: ["a", "b"] }));
    const child = await spawned(children);
    child.out.write("maybe");
    child.exit(0);
    expect((await done).label).toBeUndefined();
  });

  it("rejects with the stderr tail on a non-zero exit", async () => {
    const { instance, children } = setup();
    const done = instance.complete!(request());
    const child = await spawned(children);
    child.err.write("no api key\n");
    child.exit(2);
    await expect(done).rejects.toThrow(/no api key/);
  });

  it("kills and rejects with timeout on abort", async () => {
    const { instance, children } = setup();
    const controller = new AbortController();
    const done = instance.complete!(request({ signal: controller.signal }));
    const child = await spawned(children);
    controller.abort();
    await expect(done).rejects.toThrow(/^timeout/);
    expect(child.signals).toContain("SIGKILL");
  });

  it("kills and rejects with timeout when the deadline passes", async () => {
    const { instance, children } = setup();
    const done = instance.complete!(request({ timeoutMs: 5 }));
    const child = await spawned(children);
    await expect(done).rejects.toThrow(/^timeout/);
    expect(child.signals).toContain("SIGKILL");
  });
});
