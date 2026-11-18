import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { codexDriver } from "../src/index.ts";
import type { ChildLike, SpawnFn } from "../src/types.ts";

/**
 * Real end-to-end turn against the installed, logged-in `codex`. Off by default because it
 * spends tokens and needs a login:  TIDE_LIVE=1 pnpm --filter @tide/driver-codex test
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;

live("codex driver (live)", () => {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };

  it("reports an installed, logged-in provider with harness-supplied models", async () => {
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.kind).toBe("codex");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.every((model) => model.id !== "")).toBe(true);
    expect(status.caps.planMode).toBe(true);
    // second call is served from the 60s cache
    expect(await instance.status()).toBe(status);
    await instance.dispose();
  }, 120_000);

  it("runs one real turn and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-codex-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    const session = await instance.openSession({
      threadId: "live",
      cwd,
      mode: "auto-accept-edits",
      interaction: "default",
      mcpServers: [],
    });

    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "Reply with exactly: codex-ok" })) events.push(event);

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error(`last event was ${settled?.type}`);
    expect(settled.status).toBe("completed");

    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).toContain("codex-ok");
    expect(events.some((event) => event.type === "usage" && event.usage !== undefined)).toBe(true);

    expect(instance.terminalCommand(session.nativeSessionId!, cwd)).toContain("codex resume");
    await session.close();
    await instance.dispose();
  }, 180_000);

  // Sub-agent recordings. TIDE_LIVE_RECORD=1 rewrites test/fixtures/<name>.ndjson with the
  // raw app-server traffic (notifications and server->client requests, scrubbed).
  it("records a collab sub-agent turn the parent waits for", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-codex-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const tap = new RawTap();
    const instance = await codexDriver.create({ ...codexDriver.defaultConfig(), spawnImpl: tap.spawn }, env);
    const session = await instance.openSession({ threadId: "live-sub", cwd, mode: "auto", interaction: "default", mcpServers: [] });

    const events: NormalizedEvent[] = [];
    const prompt = "Spawn exactly one sub-agent. Its task: run `ls` and read hello.txt in the current directory, then reply with the file's contents. Wait for it to finish, then reply in one line with what it said.";
    for await (const event of session.send({ text: prompt })) {
      events.push(event);
      if (event.type === "activity" && event.activity.kind === "approval") void session.respondApproval(event.activity.requestId, "accept");
    }
    await session.close();
    await instance.dispose();
    tap.write("subagent-turn", cwd);

    expect(events.at(-1)).toMatchObject({ type: "settled", status: "completed" });
    expect(tap.lines.some((line) => line.method === "item/started" && JSON.stringify(line.params).includes("subAgentActivity"))).toBe(true);
  }, 300_000);

  it("records a sub-agent whose command needs approval while the parent does not wait", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-codex-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const tap = new RawTap();
    const instance = await codexDriver.create({ ...codexDriver.defaultConfig(), spawnImpl: tap.spawn }, env);
    const session = await instance.openSession({ threadId: "live-sub-approval", cwd, mode: "approval-required", interaction: "default", mcpServers: [] });

    const prompt = "Spawn exactly one sub-agent with this task: run `touch made-by-child.txt` in the current directory, then reply done. Do NOT wait for it: end your turn right after spawning, replying only with the word spawned.";
    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: prompt })) {
      events.push(event);
      // a card that does reach the turn gets accepted, so the child can finish
      if (event.type === "activity" && event.activity.kind === "approval") void session.respondApproval(event.activity.requestId, "accept");
    }
    // After the parent turn settles, keep listening: accept a late approval and wait for the
    // child thread's own turn/completed (bounded, so a child that never ends fails the test).
    const childDone = await tap.until((line) => {
      // the tap sees the line before the session parks it, so answer on the next tick
      if (line.id !== undefined && line.method.endsWith("/requestApproval")) setImmediate(() => void session.respondApproval(String(line.id), "accept"));
      return line.method === "turn/completed" && (line.params as { threadId?: string }).threadId !== session.nativeSessionId;
    }, 180_000);
    // Does a finished child wake the idle parent into a turn of its own? Recorded, not asserted.
    const parentWoke = await tap.until((line) => line.method === "turn/started" && (line.params as { threadId?: string }).threadId === session.nativeSessionId && tap.lines.indexOf(line) > tap.lines.findIndex((l) => l.method === "turn/completed"), 45_000);
    if (parentWoke) await tap.until((line) => line.method === "turn/completed" && (line.params as { threadId?: string }).threadId === session.nativeSessionId && tap.lines.filter((l) => l.method === "turn/completed" && (l.params as { threadId?: string }).threadId === session.nativeSessionId).length > 1, 120_000);
    console.log(`parent woke after the child finished: ${parentWoke}`);
    await session.close();
    await instance.dispose();
    tap.write("subagent-approval-turn", cwd);
    expect(childDone).toBe(true);
  }, 420_000);
});

interface RawLine {
  method: string;
  params: unknown;
  /** set for server->client requests */
  id?: string | number;
}

/**
 * Test seam over `spawnImpl`: spawns the real `codex` and tees its stdout, keeping every
 * notification and server->client request in arrival order. Production code is untouched.
 */
class RawTap {
  lines: RawLine[] = [];
  #buffer = "";
  #watchers: ((line: RawLine) => void)[] = [];

  spawn: SpawnFn = (command, args, options) => {
    const child = nodeSpawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => this.#ingest(String(chunk)));
    return child as unknown as ChildLike;
  };

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const text = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (text === "") continue;
      const frame = JSON.parse(text) as { method?: string; params?: unknown; id?: string | number };
      if (typeof frame.method !== "string") continue; // a response to one of our requests
      const line: RawLine = { method: frame.method, params: frame.params ?? null, ...(frame.id !== undefined ? { id: frame.id } : {}) };
      this.lines.push(line);
      for (const watcher of this.#watchers) watcher(line);
    }
  }

  /** Resolves true once `match` holds for a line (already seen or future), false after `timeoutMs`. */
  until(match: (line: RawLine) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      for (const line of this.lines) if (match(line)) return finish(true);
      this.#watchers.push((line) => {
        if (!done && match(line)) finish(true);
      });
    });
  }

  write(name: string, cwd: string): void {
    if (process.env["TIDE_LIVE_RECORD"] !== "1") return;
    const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${name}.ndjson`);
    writeFileSync(out, this.lines.map((line) => `${scrub(JSON.stringify(line), cwd)}\n`).join(""));
  }
}

/** Same scrub as the other recorded fixtures: no local paths, accounts, tokens or emails. */
function scrub(json: string, cwd: string): string {
  const real = realpathSync(cwd);
  return json
    .split(real).join("/tmp/repo")
    .split(cwd).join("/tmp/repo")
    .split(homedir()).join("/repo")
    .replace(/\/(private\/)?var\/folders\/[^"\\]*/g, "/tmp")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/"(accountId|account_id|userId|user_id|installationId|email|token|accessToken|idToken)":"[^"]*"/g, '"$1":"redacted"')
    .replace(/"serverName":"[^"]*"/g, '"serverName":"host.local"');
}
