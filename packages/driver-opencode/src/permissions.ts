import { relative, resolve } from "node:path";
import type { ApprovalDecision, InteractionMode, LinkedDir, RuntimeMode } from "@tide/contracts";
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

/**
 * W1 linked repos, expressed in opencode's own ruleset — no fallback needed. Verified
 * against opencode 1.1.36's `src/permission/next.ts`:
 *  - `evaluate()` picks the **last** matching rule (`merged.findLast(...)`) and the session
 *    ruleset is merged *after* the agent's (`merge(agent.permission, session.permission)`),
 *    so these rules beat both the mode rules above and the agent defaults;
 *  - `Wildcard.match` compiles `*` to `.*`, which crosses `/` — one `<path>/*` covers a
 *    whole tree;
 *  - reaching outside the project asks `external_directory` with the *absolute* glob of the
 *    target's parent directory, so allowing `<link>/*` is what makes a link readable at all;
 *  - the `edit` permission is asked with the path **relative to the worktree**, so a
 *    read-only link is denied under both its relative and its absolute form.
 */
export function linkRules(cwd: string, links: LinkedDir[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const link of links) {
    const abs = resolve(link.path);
    const rel = relative(resolve(cwd), abs);
    const globs = [abs, `${abs}/*`, ...(rel === "" ? [] : [rel, `${rel}/*`])];
    // reads (and the external-directory gate) are allowed for every link, read-only included
    for (const pattern of globs) {
      rules.push({ permission: "external_directory", pattern, action: "allow" });
      rules.push({ permission: "read", pattern, action: "allow" });
    }
    if (link.access === "write") continue;
    for (const pattern of globs) rules.push({ permission: "edit", pattern, action: "deny" });
  }
  return rules;
}

/** The session ruleset actually sent to `POST /session`: mode rules first, link rules last. */
export function sessionRuleset(mode: RuntimeMode, interaction: InteractionMode, cwd: string, links: LinkedDir[] = []): PermissionRule[] {
  return [...permissionRuleset(mode, interaction), ...linkRules(cwd, links)];
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
