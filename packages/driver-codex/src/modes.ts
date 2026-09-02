import { resolve } from "node:path";
import type { InteractionMode, OpenSessionOptions, RuntimeMode } from "@tide/contracts";
import type { CollaborationMode, CodexPolicy } from "./types.ts";

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

/**
 * `RuntimeMode` -> Codex approval/sandbox knobs, verified against codex-cli 0.147's
 * `AskForApproval` union: `"untrusted" | "on-request" | {granular} | "never"`.
 *
 * `docs/internals/providers.md` still lists `unlessTrusted`/`onRequest`/`onFailure`; the
 * server rejects all three ("unknown variant"), and 0.147 has no on-failure policy at all,
 * so `auto` maps to `never` + a workspace-write sandbox: no prompts, still sandboxed.
 *
 * `networkAccess` is **the user's own** `[sandbox_workspace_write] network_access` (see
 * `config-toml.ts`), never a Tide constant: hardcoding `false` took network away from a
 * user whose Codex config grants it.
 */
export function policyFor(mode: RuntimeMode, writableRoots: string[], networkAccess = false): CodexPolicy {
  const workspaceWrite = {
    type: "workspaceWrite" as const,
    writableRoots,
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  switch (mode) {
    case "approval-required":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: workspaceWrite };
    case "auto-accept-edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite };
    case "auto":
      return { approvalPolicy: "never", sandbox: "workspace-write", sandboxPolicy: workspaceWrite };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }
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
