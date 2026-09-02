import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { buildStatus, LOGIN_COMMAND, LOGIN_HINT } from "./status.ts";
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
