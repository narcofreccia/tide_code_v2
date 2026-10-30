import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsPolicy } from "../src/fs.ts";
import { AcpConnection, RpcError, splitLines } from "../src/jsonrpc.ts";
import { FakeChild } from "./fake-agent.ts";

function dirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tide-acp-fs-")));
  const cwd = join(root, "wt");
  const linked = join(root, "linked");
  const outside = join(root, "outside");
  for (const dir of [cwd, linked, outside]) mkdirSync(dir);
  writeFileSync(join(cwd, "a.txt"), "1\n2\n3\n4\n");
  writeFileSync(join(linked, "l.txt"), "linked");
  writeFileSync(join(outside, "secret.txt"), "secret");
  return { cwd, linked, outside };
}

describe("FsPolicy", () => {
  it("reads inside the worktree with line/limit slicing", async () => {
    const { cwd } = dirs();
    const fs = new FsPolicy(cwd);
    expect(await fs.read({ path: join(cwd, "a.txt"), line: 2, limit: 2 })).toEqual({ content: "2\n3" });
  });

  it("linked dirs: read allowed, write only with access write", async () => {
    const { cwd, linked } = dirs();
    const readOnly = new FsPolicy(cwd, [{ path: linked, label: "lib", access: "read" }]);
    expect(await readOnly.read({ path: join(linked, "l.txt") })).toEqual({ content: "linked" });
    await expect(readOnly.write({ path: join(linked, "new.txt"), content: "x" })).rejects.toThrow(/linked repo lib is read-only/);
    const writable = new FsPolicy(cwd, [{ path: linked, label: "lib", access: "write" }]);
    expect(await writable.write({ path: join(linked, "new.txt"), content: "x" })).toEqual({});
  });

  it("refuses relative paths, `..` escapes and symlinks pointing outside", async () => {
    const { cwd, outside } = dirs();
    symlinkSync(outside, join(cwd, "escape"));
    const fs = new FsPolicy(cwd);
    await expect(fs.read({ path: "a.txt" })).rejects.toThrow(/absolute/);
    await expect(fs.read({ path: join(cwd, "..", "outside", "secret.txt") })).rejects.toThrow(/outside the thread's worktree/);
    await expect(fs.read({ path: join(cwd, "escape", "secret.txt") })).rejects.toThrow(/outside the thread's worktree/);
    await expect(fs.write({ path: join(cwd, "escape", "new.txt"), content: "x" })).rejects.toBeInstanceOf(RpcError);
  });

  it("creates parent directories for writes inside the worktree", async () => {
    const { cwd } = dirs();
    expect(await new FsPolicy(cwd).write({ path: join(cwd, "deep", "er", "x.txt"), content: "x" })).toEqual({});
  });
});

describe("AcpConnection", () => {
  it("splitLines handles CRLF, blank lines and partial tails", () => {
    const lines: string[] = [];
    expect(splitLines('{"a":1}\r\n\n{"b":2}\n{"c"', (line) => lines.push(line))).toBe('{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("error replies reject with RpcError carrying the code", async () => {
    const child = new FakeChild();
    child.onClient = (message) => child.send({ id: message.id ?? null, error: { code: -32602, message: "bad" } });
    const conn = new AcpConnection(child, { label: "t", log: () => undefined, onNotification: () => undefined, onRequest: () => ({}) });
    await expect(conn.request("x", {})).rejects.toMatchObject({ code: -32602, message: "bad" });
  });

  it("close() escalates to SIGKILL when the agent ignores SIGTERM", () => {
    const child = new FakeChild();
    const signals: (string | undefined)[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    let fire: (() => void) | undefined;
    const conn = new AcpConnection(child, {
      label: "t",
      log: () => undefined,
      onNotification: () => undefined,
      onRequest: () => ({}),
      timers: { setTimeout: (fn) => ((fire = fn), 1), clearTimeout: () => undefined },
    });
    conn.close();
    expect(signals).toEqual(["SIGTERM"]);
    fire?.();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("unknown agent requests get method-not-found from the handler's RpcError", async () => {
    const child = new FakeChild();
    const conn = new AcpConnection(child, {
      label: "t",
      log: () => undefined,
      onNotification: () => undefined,
      onRequest: (method) => {
        throw new RpcError({ code: -32601, message: `no ${method}` });
      },
    });
    child.send({ id: 7, method: "terminal/create", params: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(child.received.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "no terminal/create" } });
    conn.close();
  });
});
