import { describe, expect, it } from "vitest";
import { parseSandboxNetworkAccess, parseUserSandboxConfig, readSandboxNetworkAccess } from "./config-toml.ts";
import { policyFor } from "./modes.ts";

describe("codex sandbox network access", () => {
  it("reads the key out of its section", () => {
    const toml = `
model = "gpt-5.6"

[sandbox_workspace_write]
writable_roots = ["/tmp"]
network_access = true
`;
    expect(parseSandboxNetworkAccess(toml)).toBe(true);
  });

  it("ignores the same key in another section, and comments", () => {
    const toml = `
[other]
network_access = true

[sandbox_workspace_write]
# network_access = true
network_access = false
`;
    expect(parseSandboxNetworkAccess(toml)).toBe(false);
  });

  it("understands the inline-table form", () => {
    expect(parseSandboxNetworkAccess('sandbox_workspace_write = { network_access = true, exclude_slash_tmp = false }')).toBe(true);
  });

  it("is undefined when the key is absent", () => {
    expect(parseSandboxNetworkAccess("[sandbox_workspace_write]\nwritable_roots = []\n")).toBeUndefined();
    expect(parseSandboxNetworkAccess("")).toBeUndefined();
  });

  it("defaults to Codex's own default (no network) when there is no config.toml", () => {
    expect(readSandboxNetworkAccess("/nowhere", () => undefined)).toBe(false);
  });

  it("reads config.toml from CODEX_HOME", () => {
    const seen: string[] = [];
    const value = readSandboxNetworkAccess("/custom/.codex", (path) => {
      seen.push(path);
      return "[sandbox_workspace_write]\nnetwork_access = true\n";
    });
    expect(seen).toEqual(["/custom/.codex/config.toml"]);
    expect(value).toBe(true);
  });

  it("policyFor carries the flag into every workspace-write sandbox", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(policyFor(mode, ["/repo"], true).sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: true });
      expect(policyFor(mode, ["/repo"]).sandboxPolicy).toMatchObject({ networkAccess: false });
    }
    // full-access has no workspace sandbox to configure
    expect(policyFor("full-access", ["/repo"], true).sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });
});

describe("user sandbox config is a ceiling that modes only narrow", () => {
  const toml = `
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
writable_roots = [
  "/data/shared", # comment
  '/opt/cache',
]
network_access = true
exclude_slash_tmp = true
`;

  it("parses root keys, multi-line writable_roots and the exclude flags", () => {
    expect(parseUserSandboxConfig(toml)).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      writableRoots: ["/data/shared", "/opt/cache"],
      networkAccess: true,
      excludeSlashTmp: true,
    });
    expect(parseUserSandboxConfig('sandbox_workspace_write = { writable_roots = ["/a", "/b"], network_access = false }')).toEqual({ writableRoots: ["/a", "/b"], networkAccess: false });
    expect(parseUserSandboxConfig('approval_policy = { granular = { rules = true } }')).toEqual({});
    expect(parseUserSandboxConfig("[other]\nsandbox_mode = \"read-only\"\n")).toEqual({});
  });

  it("never widens the user's approval policy", () => {
    expect(policyFor("auto", ["/repo"], false, { approvalPolicy: "on-request" }).approvalPolicy).toBe("on-request");
    expect(policyFor("auto", ["/repo"], false, { approvalPolicy: "untrusted" }).approvalPolicy).toBe("untrusted");
    expect(policyFor("approval-required", ["/repo"], false, { approvalPolicy: "never" }).approvalPolicy).toBe("untrusted");
    expect(policyFor("auto-accept-edits", ["/repo"], false, { approvalPolicy: "never" }).approvalPolicy).toBe("on-request");
    expect(policyFor("auto-accept-edits", ["/repo"], false, { approvalPolicy: "untrusted" }).approvalPolicy).toBe("untrusted");
    expect(policyFor("auto", ["/repo"], false, { approvalPolicy: "on-failure" }).approvalPolicy).toBe("on-request");
  });

  it("keeps a read-only user sandbox read-only, and never grants danger-full-access outside full-access", () => {
    expect(policyFor("auto", ["/repo"], false, { sandboxMode: "read-only", networkAccess: true })).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(policyFor(mode, ["/repo"], false, { sandboxMode: "danger-full-access" }).sandbox).toBe("workspace-write");
    }
  });

  it("full-access keeps the user's approval policy and is the only mode that sends danger-full-access", () => {
    expect(policyFor("full-access", ["/repo"], false, { approvalPolicy: "on-request" })).toEqual({ approvalPolicy: "on-request", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(policyFor("full-access", ["/repo"]).approvalPolicy).toBe("never");
  });

  it("unions the user's writable_roots with the thread's and carries the exclude flags", () => {
    expect(policyFor("auto", ["/repo", "/data/shared"], false, { writableRoots: ["/data/shared", "/opt/cache"], excludeSlashTmp: true }).sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo", "/data/shared", "/opt/cache"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    });
  });
});
