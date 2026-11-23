import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { fakeSpawn } from "./fake-app-server.ts";
import { codexDriver } from "./index.ts";
import { CODEX_CAPS, FREE_PLAN_NOTE, INSTALL_HINT, LOGIN_COMMAND, LOGIN_HINT, accountLabel, detectBinary, parseVersion, toModelInfo } from "./status.ts";
import { mcpEnvAndArgs, TIDE_MCP_TOOL_TIMEOUT_SEC } from "./app-server.ts";
import { collaborationModeFor, policyFor } from "./modes.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

describe("status", () => {
  it("parses the version out of `codex --version`", () => {
    expect(parseVersion("codex-cli 0.147.0\n")).toBe("0.147.0");
    expect(parseVersion("garbage")).toBeUndefined();
  });

  it("maps codex's model catalogue onto ModelInfo, hiding hidden models", () => {
    const models = toModelInfo(
      [
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: true },
        { id: "gpt-5.4-codex", model: "gpt-5.4-codex", displayName: "GPT-5.4-Codex", hidden: false, isDefault: false },
        { id: "internal", model: "internal", displayName: "Internal", hidden: true, isDefault: false },
      ] as Parameters<typeof toModelInfo>[0],
      undefined,
    );
    expect(models).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", family: "gpt-5.6", default: true },
      { id: "gpt-5.4-codex", label: "GPT-5.4-Codex", family: "gpt-5.4", default: false },
    ]);
    // a configured default wins over the catalogue's own flag
    expect(toModelInfo([{ id: "a", model: "a", displayName: "A", hidden: false, isDefault: true }] as Parameters<typeof toModelInfo>[0], "b")[0]?.default).toBe(false);
  });

  it("reports installed + logged-in status from a short-lived app-server, and caches it for 60s", async () => {
    const { spawn, servers } = fakeSpawn();
    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: spawn }, env);
    const status = await instance.status();
    expect(status.kind).toBe("codex");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.hint).toBe("ChatGPT pro plan");
    expect(status.loginCommand).toBeUndefined();
    expect(status.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", family: "gpt-5.6", default: true }]);
    expect(status.caps).toEqual({ ...CODEX_CAPS });
    expect(servers[0]?.killed).toBe(1);
    expect(await instance.status()).toBe(status);
    expect(servers).toHaveLength(1);
    const refreshed = await instance.status(true);
    expect(refreshed).not.toBe(status);
    expect(servers).toHaveLength(2);
    expect(await instance.status()).toBe(refreshed);
    await instance.dispose();
  });

  it("hints at `codex login` when account/read returns no account", async () => {
    const { spawn } = fakeSpawn((server) => {
      server.account = null;
    });
    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: spawn }, env);
    const status = await instance.status();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toBe(LOGIN_HINT);
    expect(status.loginCommand).toBe(LOGIN_COMMAND);
    await instance.dispose();
  });

  it("a failed probe says the login state is unknown instead of claiming logged out", async () => {
    const { spawn, servers } = fakeSpawn();
    const signedOut: typeof spawn = (command, args, options) => {
      const child = spawn(command, args, options);
      servers.at(-1)!.failMethods.set("account/read", "not logged in");
      return child;
    };
    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: signedOut }, env);
    const status = await instance.status();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.hint).toMatch(/^Could not read Codex's login state \(.*not logged in.*\)\. Refresh to retry/);
    expect(status.loginCommand).toBe(LOGIN_COMMAND);
    await instance.dispose();
  });

  it("labels a free ChatGPT plan and warns that its catalogue is limited", async () => {
    const { spawn } = fakeSpawn((server) => {
      server.account = { type: "chatgpt", email: "dev@example.com", planType: "free" };
    });
    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: spawn }, env);
    const status = await instance.status();
    expect(status.loggedIn).toBe(true);
    expect(status.hint).toContain("free plan");
    expect(status.hint).toContain("--with-api-key");
    expect(status.hint).toBe("ChatGPT free plan" + FREE_PLAN_NOTE);
    // the note does not name models: the catalogue changes under it
    expect(FREE_PLAN_NOTE).not.toMatch(/GPT-\d/i);
    await instance.dispose();
  });

  it("labels an API-key account", async () => {
    const { spawn } = fakeSpawn((server) => {
      server.account = { type: "apiKey" };
    });
    const instance = await codexDriver.create({ binaryPath: process.execPath, spawnImpl: spawn }, env);
    const status = await instance.status();
    expect(status.loggedIn).toBe(true);
    expect(status.hint).toBe("OpenAI API key");
    await instance.dispose();
  });

  it("derives account labels defensively from the Account union", () => {
    expect(accountLabel(null)).toBeUndefined();
    expect(accountLabel(undefined)).toBeUndefined();
    expect(accountLabel({ type: "apiKey" })).toBe("OpenAI API key");
    expect(accountLabel({ type: "chatgpt", email: null, planType: "plus", workspaceName: null })).toBe("ChatGPT plus plan");
    expect(accountLabel({ type: "amazonBedrock", usesCodexManagedCredentials: false })).toBeUndefined();
  });

  it("reports a missing binary with an install hint and no models", async () => {
    const instance = await codexDriver.create({ binaryPath: "/nonexistent/codex", env: { PATH: "/nonexistent", HOME: "/nonexistent" } }, env);
    const status = await instance.status();
    expect(status.installed).toBe(false);
    expect(status.hint).toBe(INSTALL_HINT);
    // a missing binary is an install problem, not a login one
    expect(status.loginCommand).toBeUndefined();
    expect(status.models).toEqual([]);
    await instance.dispose();
  });

  /** A scratch HOME with an executable `codex` at `<home>/<dir>/codex`. */
  function fakeCodex(home: string, dir: string): string {
    mkdirSync(join(home, dir), { recursive: true });
    const file = join(home, dir, "codex");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return file;
  }

  it("falls back to ~/.local/bin/codex (from config.env.HOME) when PATH has no codex", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const local = fakeCodex(home, ".local/bin");
    expect(await detectBinary({ env: { PATH: "/nonexistent", HOME: home } })).toBe(local);
  });

  it("prefers a codex on PATH over the fixed location", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    fakeCodex(home, ".local/bin");
    const onPath = fakeCodex(home, "pinned");
    // `/usr/bin/env which` resolves `which` itself through this PATH, so it keeps the system dirs
    expect(await detectBinary({ env: { PATH: [join(home, "pinned"), "/usr/bin", "/bin"].join(":"), HOME: home } })).toBe(onPath);
  });

  it("offers `codex resume <threadId>` as the terminal escape hatch, with CODEX_HOME and binaryPath when configured", async () => {
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    expect(instance.terminalCommand("01a05503-390c-7520", "/tmp/my repo")).toBe("cd '/tmp/my repo' && codex resume 01a05503-390c-7520");
    await instance.dispose();
    const work = await codexDriver.create({ binaryPath: "/opt/codex" }, { ...env, instance: { id: "codex:work", label: "Work", home: "/homes/codex work" } });
    expect(work.terminalCommand("01a05503-390c-7520", "/tmp/repo")).toBe("cd /tmp/repo && CODEX_HOME='/homes/codex work' /opt/codex resume 01a05503-390c-7520");
    await work.dispose();
  });
});

describe("mode mapping", () => {
  it("maps every RuntimeMode onto knobs codex 0.147 actually accepts", () => {
    expect(policyFor("approval-required", ["/repo"])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(policyFor("auto-accept-edits", ["/repo"])).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(policyFor("auto", ["/repo"])).toMatchObject({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(policyFor("full-access", ["/repo"])).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(policyFor("approval-required", ["/repo"]).sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("keeps codex's own plan instructions rather than injecting Tide's", () => {
    expect(collaborationModeFor("plan", "m")).toEqual({ mode: "plan", settings: { model: "m", reasoning_effort: null, developer_instructions: null } });
    expect(collaborationModeFor("default", "m").mode).toBe("default");
  });

  it("adds MCP servers as merging dotted -c overrides, splitting tide into tide + tide-direct", () => {
    expect(mcpEnvAndArgs([{ name: "tide", command: "node", args: ["a b.js"], env: { K: "v" } }])).toEqual({
      args: [
        "-c", 'mcp_servers.tide.command="node"',
        "-c", 'mcp_servers.tide.args=["a b.js"]',
        "-c", "mcp_servers.tide.tool_timeout_sec=900.0",
        "-c", 'mcp_servers.tide.disabled_tools=["tide_delegate", "tide_thread_wait"]',
        "-c", 'mcp_servers.tide.env_vars=["K"]',
        "-c", 'mcp_servers.tide-direct.command="node"',
        "-c", 'mcp_servers.tide-direct.args=["a b.js"]',
        "-c", "mcp_servers.tide-direct.tool_timeout_sec=900.0",
        "-c", 'mcp_servers.tide-direct.enabled_tools=["tide_delegate", "tide_thread_wait"]',
        "-c", 'mcp_servers.tide-direct.omit_tools_from=["code_mode", "deferred"]',
        "-c", 'mcp_servers.tide-direct.env_vars=["K"]',
      ],
      env: { K: "v" },
    });
    expect(mcpEnvAndArgs([])).toEqual({ args: [], env: {} });
  });

  it("gives every Tide MCP server a tool timeout above the 600 s its blocking tools can take", () => {
    const { args } = mcpEnvAndArgs([
      { name: "tide", command: "node" },
      { name: "tide-experts", command: "node", args: ["x.js"] },
    ]);
    const timeouts = args.filter((arg) => arg.includes(".tool_timeout_sec="));
    expect(timeouts).toEqual(["mcp_servers.tide.tool_timeout_sec=900.0", "mcp_servers.tide-direct.tool_timeout_sec=900.0", "mcp_servers.tide-experts.tool_timeout_sec=900.0"]);
    // each value must parse as a TOML float (codex rejects a string: "expected f64") and exceed 600
    for (const arg of timeouts) expect(Number(arg.split("=")[1])).toBeGreaterThan(600);
    expect(TIDE_MCP_TOOL_TIMEOUT_SEC).toBeGreaterThan(600);
  });

  it("keeps MCP secrets off argv, and only falls back to the visible form on a value collision", () => {
    const { args, env } = mcpEnvAndArgs(
      [
        { name: "tide", command: "node", env: { TIDE_AGENT_TOKEN: "s3cret" } },
        { name: "other", command: "node", env: { TIDE_AGENT_TOKEN: "different" } },
      ],
      () => undefined,
    );
    // the first server's value is forwarded through the app-server's own environment…
    expect(env).toEqual({ TIDE_AGENT_TOKEN: "s3cret" });
    expect(args).toContain('mcp_servers.tide.env_vars=["TIDE_AGENT_TOKEN"]');
    expect(args.join(" ")).not.toContain("s3cret");
    // …the second cannot be, since one process env holds one value per name
    expect(args).toContain('mcp_servers.other.env.TIDE_AGENT_TOKEN="different"');
  });
});
