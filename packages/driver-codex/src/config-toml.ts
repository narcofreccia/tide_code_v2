import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex's own `~/.codex/config.toml` is the source of truth for the sandbox's network
 * policy — hardcoding `networkAccess: false` would silently cripple a user who turned it on
 * (CLAUDE.md §1a). This is a deliberately tiny lookup for exactly one key rather than a TOML
 * dependency: the server never adds native/heavy deps for a single boolean.
 *
 * Codex's default when the key is absent is **no network access** (the `workspace-write`
 * sandbox denies egress unless `network_access = true` opts in), so `undefined` means false.
 */

/** `[sandbox_workspace_write] network_access`, or `undefined` when the key is not set. */
export function parseSandboxNetworkAccess(toml: string): boolean | undefined {
  let inSection = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inSection = header[1]?.trim() === "sandbox_workspace_write";
      continue;
    }
    // inline table: `sandbox_workspace_write = { network_access = true, … }`
    const inline = /^sandbox_workspace_write\s*=\s*\{(.*)\}$/.exec(line);
    if (inline) {
      const value = /(?:^|,)\s*network_access\s*=\s*(true|false)/.exec(inline[1] ?? "");
      if (value) return value[1] === "true";
      continue;
    }
    if (!inSection) continue;
    const value = /^network_access\s*=\s*(true|false)$/.exec(line);
    if (value) return value[1] === "true";
  }
  return undefined;
}

export type TomlReader = (path: string) => string | undefined;

const readOrUndefined: TomlReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // no config.toml at all is the common case
  }
};

/** Resolves the effective sandbox network policy for `workspace-write` sandboxes. */
export function readSandboxNetworkAccess(codexHome?: string, read: TomlReader = readOrUndefined): boolean {
  const home = codexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const toml = read(join(home, "config.toml"));
  if (toml === undefined) return false;
  return parseSandboxNetworkAccess(toml) ?? false;
}
