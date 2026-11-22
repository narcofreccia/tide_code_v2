import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { ClaudeInstance } from "./instance.ts";
import { buildStatus, detectLogin, LOGIN_COMMAND, LOGIN_HINT } from "./status.ts";
import type { QueryFn } from "./types.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
const noQuery: QueryFn = () => {
  throw new Error("the model list must not be fetched for a status probe in these tests");
};

describe("claude status", () => {
  it("offers the exact login command alongside the prose hint", () => {
    // the UI runs `loginCommand` verbatim in a terminal, so it must be the real subcommand
    // (verified against `claude auth --help`, Claude Code 2.1.x)
    expect(LOGIN_COMMAND).toBe("claude auth login");
    expect(LOGIN_HINT).toContain(LOGIN_COMMAND);
  });

  it("sets loginCommand only when the CLI is installed but signed out", async () => {
    // hermetic in both directions: the invariant holds whether or not this machine has claude
    const status = await buildStatus({ binaryPath: "/nonexistent/claude" }, env, noQuery);
    expect(status.loginCommand).toBe(status.installed && !status.loggedIn ? LOGIN_COMMAND : undefined);
    if (!status.installed) expect(status.hint).toMatch(/Install Claude Code/);
  });
});

describe("claude caps", () => {
  it("reports oneShot in status", async () => {
    const status = await buildStatus({ binaryPath: "/nonexistent/claude" }, env, noQuery);
    expect(status.caps.oneShot).toBe(true);
  });

  it("detectLogin honours a secondary account's CLAUDE_CONFIG_DIR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-acct-"));
    expect(await detectLogin("/nonexistent/claude", dir)).toBe(false);
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect(await detectLogin("/nonexistent/claude", dir)).toBe(true);
  });

  it("terminalCommand includes CLAUDE_CONFIG_DIR and binaryPath for extra accounts", () => {
    const plain = new ClaudeInstance({}, env, noQuery);
    expect(plain.terminalCommand("sess-1", "/tmp/my repo")).toBe("cd '/tmp/my repo' && claude --resume sess-1");
    const work = new ClaudeInstance({ binaryPath: "/opt/claude" }, { ...env, instance: { id: "claude:work", label: "Work", home: "/homes/work claude" } }, noQuery);
    expect(work.terminalCommand("sess-1", "/tmp/repo")).toBe("cd /tmp/repo && CLAUDE_CONFIG_DIR='/homes/work claude' /opt/claude --resume sess-1");
  });
});
