import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { ClaudeInstance } from "./instance.ts";
import { buildStatus, detectLogin, LOGIN_COMMAND, LOGIN_HINT } from "./status.ts";
import type { QueryFn } from "./types.ts";
import { rateLimitsFromUsageResponse } from "./usage.ts";

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

  it("maps structured SDK /usage rate_limits into session, weekly, and exhausted per-model windows", () => {
    const reset5h = "2026-11-22T16:00:00.000Z";
    const reset7d = "2026-11-24T00:00:00.000Z";
    const limits = rateLimitsFromUsageResponse(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 100, resets_at: reset5h },
          seven_day: { utilization: 63, resets_at: reset7d },
          model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: reset7d }],
        },
      },
      1234,
    );
    expect(limits).toEqual([
      { status: "limited", remainingPct: 0, resetsAt: Date.parse(reset5h), window: "session", windowMins: 300, note: "five_hour 100% used", at: 1234 },
      { status: "ok", remainingPct: 37, resetsAt: Date.parse(reset7d), window: "weekly", windowMins: 10080, note: "seven_day 63% used", at: 1234 },
      { status: "limited", remainingPct: 0, resetsAt: Date.parse(reset7d), note: "Fable 100% used", at: 1234 },
    ]);
    expect(rateLimitsFromUsageResponse({ rate_limits_available: false, rate_limits: null }, 1234)).toEqual([]);
  });
});
