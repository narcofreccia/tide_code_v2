import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex's own `~/.codex/config.toml` is the source of truth for the user's sandbox and
 * approval stance. Tide reads the handful of keys that matter (`modes.ts` only ever NARROWS
 * them per RuntimeMode) with a deliberately tiny reader instead of a TOML dependency: the
 * server never adds native/heavy deps for a few scalars and one string array.
 *
 * Not read: `[profiles.*]` / `profile = …` (a selected profile can override these keys; Tide
 * then applies the base values, which is the conservative side only when the profile widens).
 */

export type UserSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type UserApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

/** What the user's config.toml says; every field is `undefined` when the key is not set. */
export interface UserSandboxConfig {
  sandboxMode?: UserSandboxMode;
  approvalPolicy?: UserApprovalPolicy;
  /** `[sandbox_workspace_write] writable_roots` */
  writableRoots?: string[];
  /** `[sandbox_workspace_write] network_access` */
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

const SANDBOX_SECTION = "sandbox_workspace_write";

/** Flattens the TOML into `key` (root) / `section.key` -> raw value text. Multi-line arrays are joined. */
function readKeys(toml: string): Map<string, string> {
  const keys = new Map<string, string>();
  let section = "";
  let pending: { key: string; text: string } | undefined;
  const store = (key: string, value: string): void => {
    keys.set(key, value);
    // inline table: `sandbox_workspace_write = { network_access = true, … }`
    if (key !== SANDBOX_SECTION) return;
    const body = /^\{(.*)\}$/.exec(value)?.[1] ?? "";
    for (const entry of body.matchAll(/([A-Za-z_]+)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|[^,}]+)/g)) keys.set(`${SANDBOX_SECTION}.${entry[1]}`, (entry[2] ?? "").trim());
  };
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (pending) {
      pending.text += ` ${line}`;
      if (line.includes("]")) {
        store(pending.key, pending.text);
        pending = undefined;
      }
      continue;
    }
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]?.trim() ?? "";
      continue;
    }
    const assign = /^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!assign) continue;
    const key = section === "" ? assign[1]! : `${section}.${assign[1]}`;
    const value = (assign[2] ?? "").trim();
    if (value.startsWith("[") && !value.includes("]")) pending = { key, text: value };
    else store(key, value);
  }
  return keys;
}

const asBool = (value: string | undefined): boolean | undefined => (value === "true" ? true : value === "false" ? false : undefined);
const asString = (value: string | undefined): string | undefined => /^(?:"([^"]*)"|'([^']*)')$/.exec(value ?? "")?.slice(1).find((part) => part !== undefined);

/** Parses the user's sandbox/approval stance out of config.toml text. */
export function parseUserSandboxConfig(toml: string): UserSandboxConfig {
  const keys = readKeys(toml);
  const sandboxMode = asString(keys.get("sandbox_mode"));
  const approval = asString(keys.get("approval_policy")); // `{ granular = … }` tables are ignored on purpose
  const roots = keys.get(`${SANDBOX_SECTION}.writable_roots`);
  const config: UserSandboxConfig = {};
  if (sandboxMode === "read-only" || sandboxMode === "workspace-write" || sandboxMode === "danger-full-access") config.sandboxMode = sandboxMode;
  if (approval === "untrusted" || approval === "on-failure" || approval === "on-request" || approval === "never") config.approvalPolicy = approval;
  if (roots !== undefined) config.writableRoots = [...roots.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "").filter((root) => root !== "");
  const network = asBool(keys.get(`${SANDBOX_SECTION}.network_access`));
  if (network !== undefined) config.networkAccess = network;
  const tmpdir = asBool(keys.get(`${SANDBOX_SECTION}.exclude_tmpdir_env_var`));
  if (tmpdir !== undefined) config.excludeTmpdirEnvVar = tmpdir;
  const slashTmp = asBool(keys.get(`${SANDBOX_SECTION}.exclude_slash_tmp`));
  if (slashTmp !== undefined) config.excludeSlashTmp = slashTmp;
  return config;
}

/** `[sandbox_workspace_write] network_access`, or `undefined` when the key is not set. */
export function parseSandboxNetworkAccess(toml: string): boolean | undefined {
  return parseUserSandboxConfig(toml).networkAccess;
}

export type TomlReader = (path: string) => string | undefined;

const readOrUndefined: TomlReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // no config.toml at all is the common case
  }
};

/** The user's config.toml stance; `{}` when there is no file. */
export function readUserSandboxConfig(codexHome?: string, read: TomlReader = readOrUndefined): UserSandboxConfig {
  const home = codexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const toml = read(join(home, "config.toml"));
  return toml === undefined ? {} : parseUserSandboxConfig(toml);
}

/**
 * Effective network policy for `workspace-write` sandboxes. Codex's default when the key is
 * absent is **no network access**, so `undefined` means false.
 */
export function readSandboxNetworkAccess(codexHome?: string, read: TomlReader = readOrUndefined): boolean {
  return readUserSandboxConfig(codexHome, read).networkAccess ?? false;
}
