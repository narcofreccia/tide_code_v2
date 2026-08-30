import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { fakeSpawn } from "./fake-app-server.ts";
import { codexDriver } from "./index.ts";
import { CODEX_CAPS, INSTALL_HINT, LOGIN_HINT, parseVersion, toModelInfo } from "./status.ts";
import { mcpConfigArgs } from "./app-server.ts";
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
    expect(status.hint).toBeUndefined();
    expect(status.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", family: "gpt-5.6", default: true }]);
    expect(status.caps).toEqual({ ...CODEX_CAPS });
    expect(servers[0]?.killed).toBe(1);
    expect(await instance.status()).toBe(status);
    expect(servers).toHaveLength(1);
    await instance.dispose();
  });

  it("hints at `codex login` when account/read returns no account", async () => {
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
    expect(status.hint).toBe(LOGIN_HINT);
    await instance.dispose();
  });

  it("reports a missing binary with an install hint and no models", async () => {
    const instance = await codexDriver.create({ binaryPath: "/nonexistent/codex", env: { PATH: "/nonexistent" } }, env);
    const status = await instance.status();
    expect(status.installed).toBe(false);
    expect(status.hint).toBe(INSTALL_HINT);
    expect(status.models).toEqual([]);
    await instance.dispose();
  });

  it("offers `codex resume <threadId>` as the terminal escape hatch", async () => {
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    expect(instance.terminalCommand("01a05503-390c-7520", "/tmp/my repo")).toBe("cd '/tmp/my repo' && codex resume 01a05503-390c-7520");
    await instance.dispose();
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

  it("adds MCP servers as merging dotted -c overrides, leaving the user's own untouched", () => {
    expect(mcpConfigArgs([{ name: "tide", command: "node", args: ["a b.js"], env: { K: "v" } }])).toEqual([
      "-c",
      'mcp_servers.tide.command="node"',
      "-c",
      'mcp_servers.tide.args=["a b.js"]',
      "-c",
      'mcp_servers.tide.env.K="v"',
    ]);
    expect(mcpConfigArgs([])).toEqual([]);
  });
});
