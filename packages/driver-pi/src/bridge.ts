import { existsSync, statSync } from "node:fs";
import type { InteractionMode, RuntimeMode } from "@tide/contracts";
import { resolveBridgePath } from "./bridge-path.ts";
import type { PiDeps } from "./types.ts";

/**
 * What a pi session runs without tide-bridge, and when Tide refuses to open it.
 *
 * pi has no permission system of its own: approvals, plan mode, read-only linked repos, the
 * Tide preamble and Tide's MCP servers (tide_delegate, experts, secrets) all live in the bridge's
 * hooks (`tool_call`, `before_agent_start`, `registerMcpServer`). Without it every tool call runs
 * unasked. So a mode that promises a gate (`approval-required`, `auto-accept-edits`, plan) is
 * refused when the bridge is certainly absent (no path to pass to `pi -e`); a bridge that was
 * passed but did not register `/tide-config` is only warned about (an older pi may not list it).
 */

/** "loaded": `/tide-config` is listed as an extension command; "missing": not passed or not listed; "unknown": pi did not answer `get_commands`. */
export type BridgeState = "loaded" | "missing" | "unknown";

/** The path handed to `pi -e`: the deps' (null = none), else the installed @tide/pi-extensions. */
export function bridgePathOf(deps: Pick<PiDeps, "bridgePath">): string | undefined {
  return deps.bridgePath === null ? undefined : (deps.bridgePath ?? resolveBridgePath());
}

/** Provider status line while the bridge cannot be found (Settings › Providers). */
export const BRIDGE_STATUS_HINT = "tide-bridge not found: pi threads run only in Auto mode, without approvals, plan mode or Tide tools (tide_delegate, experts, secrets)";

/** The thread's settings rely on the bridge to gate tool calls. */
export function needsGate(mode: RuntimeMode, interaction: InteractionMode): boolean {
  return mode !== "auto" || interaction === "plan";
}

export const BRIDGE_NOT_FOUND = "tide-bridge was not found";

/** Thrown from `openSession`: running ungated would break the mode the user picked. */
export function refusalFor(mode: RuntimeMode, interaction: InteractionMode): string {
  const what = interaction === "plan" ? "plan mode" : mode === "approval-required" ? "approvals" : "approvals for commands";
  return `pi cannot enforce ${what} without tide-bridge (${BRIDGE_NOT_FOUND}; pi itself asks before nothing). Switch this thread to Auto, or reinstall Tide so @tide/pi-extensions is present.`;
}

/** The one info row a session opened without a working bridge shows on its first turn. */
export function bridgeNotice(state: BridgeState, passed: boolean): string | undefined {
  if (state === "loaded" || state === "unknown") return undefined;
  if (!passed) return `Tide tools are not available in this session: ${BRIDGE_NOT_FOUND}, so pi runs without tide_delegate, experts and secrets tools, and every tool call runs without asking.`;
  return "Tide tools are not available in this session: tide-bridge did not register in pi, so approvals and plan mode are not enforced and tide_delegate, experts and secrets tools are missing.";
}

/**
 * `pi --session <path>` on a missing or empty file silently starts a new session at that path
 * (SessionManager `_setSessionFile`); an id that matches nothing makes pi exit instead. True
 * when the resume target is a path whose file holds no session.
 */
export function sessionFileGone(resume: string): boolean {
  const isPath = resume.includes("/") || resume.includes("\\") || resume.endsWith(".jsonl");
  if (!isPath) return false;
  try {
    return !existsSync(resume) || statSync(resume).size === 0;
  } catch {
    return false;
  }
}
