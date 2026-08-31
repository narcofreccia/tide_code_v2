import type { ApprovalDecision, InteractionMode, RuntimeMode } from "@tide/contracts";
import type { PermissionReply, PermissionRule } from "./wire.ts";

/**
 * `POST /session` takes a per-session `permission` ruleset (`{permission, pattern, action}`
 * triples) that is layered over the agent's own rules. That is the whole mapping: Tide
 * never writes `opencode.json` into the user's project.
 *
 * Only the four knobs Tide's modes are about are set — `edit`, `bash`, `webfetch` and (for
 * full access) the catch-all. Everything else keeps whatever the user's own config and the
 * selected agent decided, so skills, MCP tools and custom permissions stay live.
 */
const RULESETS: Record<RuntimeMode, PermissionRule[]> = {
  "approval-required": [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ],
  "auto-accept-edits": [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ],
  auto: [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "allow" },
  ],
  "full-access": [{ permission: "*", pattern: "*", action: "allow" }],
};

/**
 * In plan mode the `plan` agent's own ruleset is what makes planning safe (`edit: deny`
 * outside the plans dir). A blanket `allow` from the run mode would undo it, so plan
 * sessions keep only the `ask` rules; the plan agent governs the rest.
 */
export function permissionRuleset(mode: RuntimeMode, interaction: InteractionMode): PermissionRule[] {
  const rules = RULESETS[mode];
  return interaction === "plan" ? rules.filter((rule) => rule.action === "ask") : [...rules];
}

export function replyFor(decision: ApprovalDecision): PermissionReply {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      // opencode has one "remember this" bucket; it persists for the session's project.
      return "always";
    default:
      return "reject";
  }
}
