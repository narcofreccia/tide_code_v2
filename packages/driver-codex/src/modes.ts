import { resolve } from "node:path";
import type { InteractionMode, OpenSessionOptions, RuntimeMode } from "@tide/contracts";
import type { UserApprovalPolicy, UserSandboxConfig } from "./config-toml.ts";
import type { AskForApproval, CollaborationMode, CodexPolicy, SandboxMode } from "./types.ts";

/**
 * W1: the sandbox's writable roots are the thread's cwd plus every *write* linked repo.
 * Read-only links need no entry — a `workspace-write` sandbox can already read the whole
 * filesystem, and leaving them out is exactly what makes them read-only.
 */
export function writableRoots(options: Pick<OpenSessionOptions, "cwd" | "linkedDirs">): string[] {
  const roots = [resolve(options.cwd)];
  for (const dir of options.linkedDirs ?? []) {
    if (dir.access !== "write") continue;
    const path = resolve(dir.path);
    if (!roots.includes(path)) roots.push(path);
  }
  return roots;
}

/** Autonomy order (least to most): a higher approval policy asks the user less often. */
const APPROVAL_RANK: Record<UserApprovalPolicy, number> = { untrusted: 0, "on-failure": 1, "on-request": 2, never: 3 };
const SANDBOX_RANK: Record<SandboxMode, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

/**
 * `RuntimeMode` -> Codex approval/sandbox knobs, verified against codex-cli 0.147/0.162's
 * `AskForApproval` union: `"untrusted" | "on-request" | {granular} | "never"` (the server
 * rejects the older `unlessTrusted`/`onRequest`/`onFailure`; there is no on-failure policy).
 *
 * The user's own `config.toml` (`config-toml.ts`) is a ceiling, never replaced: a mode may
 * only NARROW it. Per mode, the effective value is the *narrower* of the mode's level and
 * whatever the user set (an unset key imposes no ceiling):
 *
 *   mode               approval_policy                        sandbox
 *   approval-required  min(untrusted, user)  = untrusted      min(workspace-write, user)
 *   auto-accept-edits  min(on-request, user)                  min(workspace-write, user)
 *   auto               min(never, user)      = user ?? never  min(workspace-write, user)
 *   full-access        user ?? never                          danger-full-access (explicit thread choice)
 *
 * `writable_roots`, `network_access`, `exclude_*` from `[sandbox_workspace_write]` are the
 * user's own allowances and carry over (roots are unioned with the thread's cwd + write
 * links). A user `sandbox_mode = "read-only"` therefore stays read-only in every non-full
 * mode. `danger-full-access` is only ever sent for a `full-access` thread — a user config
 * that allows it does not widen the other modes.
 */
export function policyFor(mode: RuntimeMode, writableRoots: string[], networkAccess = false, user: UserSandboxConfig = {}): CodexPolicy {
  const network = user.networkAccess ?? networkAccess;
  if (mode === "full-access") {
    const approvalPolicy = user.approvalPolicy === "on-failure" ? "on-request" : (user.approvalPolicy ?? "never");
    return { approvalPolicy, sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  const ceiling: UserApprovalPolicy = mode === "approval-required" ? "untrusted" : mode === "auto-accept-edits" ? "on-request" : "never";
  const approval = narrowerApproval(ceiling, user.approvalPolicy);
  const sandbox: SandboxMode = user.sandboxMode !== undefined && SANDBOX_RANK[user.sandboxMode] < SANDBOX_RANK["workspace-write"] ? user.sandboxMode : "workspace-write";
  if (sandbox === "read-only") return { approvalPolicy: approval, sandbox, sandboxPolicy: { type: "readOnly", networkAccess: network } };
  const roots = [...writableRoots];
  for (const root of user.writableRoots ?? []) if (!roots.includes(root)) roots.push(root);
  return {
    approvalPolicy: approval,
    sandbox,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: roots,
      networkAccess: network,
      excludeTmpdirEnvVar: user.excludeTmpdirEnvVar ?? false,
      excludeSlashTmp: user.excludeSlashTmp ?? false,
    },
  };
}

function narrowerApproval(ceiling: UserApprovalPolicy, user: UserApprovalPolicy | undefined): AskForApproval {
  const chosen = user !== undefined && APPROVAL_RANK[user] < APPROVAL_RANK[ceiling] ? user : ceiling;
  return chosen === "on-failure" ? "on-request" : chosen; // 0.162 has no on-failure; on-request is the nearest equally-or-more-asking policy
}

/**
 * Codex's native plan mode is a *collaboration mode* passed per turn. It is absent from the
 * generated `TurnStartParams` (a ts-rs binding gap) but the server parses and honours it —
 * verified live: `turn/start` with `{mode:"plan", settings}` makes `thread/settings/updated`
 * report `collaborationMode.mode === "plan"` with Codex's own Plan Mode instructions, while
 * `{mode:"plan"}` alone is rejected with "missing field `settings`".
 *
 * `developer_instructions: null` keeps Codex's built-in plan prompt (never our own).
 */
export function collaborationModeFor(interaction: InteractionMode, model: string): CollaborationMode {
  return { mode: interaction === "plan" ? "plan" : "default", settings: { model, reasoning_effort: null, developer_instructions: null } };
}
