import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { ApprovalDecision, InteractionMode, LinkedDir, RuntimeMode } from "@tide/contracts";
import type { PermissionAction, PermissionReply, PermissionRule, WirePermissionConfig } from "./wire.ts";

const ACTIONS = new Set<string>(["allow", "deny", "ask"]);

/**
 * `POST /session` takes a per-session `permission` ruleset (`{permission, pattern, action}`
 * triples) that is layered over the agent's own rules. That is the whole mapping: Tide
 * never writes `opencode.json` into the user's project.
 *
 * Verified against the installed opencode 1.1.36 binary:
 *  - a rule's `permission` is a plain `z.string()` matched with `Wildcard.match(asked,
 *    rule.permission)`, so `"*"` is a legal key that matches every permission — opencode's
 *    own agent defaults are built from `{"*": "allow", …}`;
 *  - the ruleset a tool call is evaluated against is
 *    `merge(agent.permission, session.permission ?? [])` and `evaluate` takes
 *    `merged.findLast(...)`, so Tide's session rules are evaluated **last** and win;
 *  - **the built-in agents' baseline is `"*": "allow"`** (`Agent` state:
 *    `fromConfig({"*": "allow", doom_loop: "ask", external_directory: {...}, question:
 *    "deny", plan_enter: "deny", plan_exit: "deny", read: {"*.env": "ask", …}})`, then the
 *    user's `opencode.json` `permission` block). Emitting *no* session rules therefore does
 *    **not** mean "ask" — it means "allow". The `ask` rules below are what makes
 *    approval-required and auto-accept-edits mean anything at all; they are the one place
 *    Tide deliberately overrides the user's own config, because the thread's run mode is a
 *    per-thread choice the user just made in Tide.
 *
 * Only the three knobs Tide's modes are about are set — `edit`, `bash`, `webfetch` (plus
 * the catch-all for full access). Everything else keeps whatever the user's own config and
 * the selected agent decided, so skills, MCP tools and custom permissions stay live.
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
  // `"*"` is a wildcard *permission key*, not a literal — `Wildcard.match(asked, "*")`
  // matches everything, exactly as opencode's own `{"*": "allow"}` agent default does.
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

/** `PermissionNext.expand` (opencode 1.1.36 `src/permission/next.ts`). */
function expandPattern(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1);
  if (pattern.startsWith("$HOME")) return homedir() + pattern.slice(5);
  return pattern;
}

/**
 * The user's *granular* permission rules, replayed from their own `opencode.json` so Tide's
 * mode rules cannot silently cancel them.
 *
 * Why this is needed: session rules are evaluated after the agent's (which is where the
 * user's config lives), so a blanket `bash:* ask` from a Tide mode would otherwise beat a
 * user's `{"bash": {"git *": "allow"}}`. Re-appending their rules after Tide's restores the
 * precedence those rules have when opencode runs without Tide.
 *
 * Why only the granular ones: a rule whose pattern is `*` is the user's terminal-wide
 * *default* for that permission. Letting it win here would make Tide's per-thread mode
 * selector a lie — picking "approval-required" on a thread would do nothing for a user whose
 * config says `"bash": "allow"`. A pattern-bearing rule (`"git *": "allow"`,
 * `"rm -rf *": "deny"`) is a specific intent about specific calls, which the mode should
 * not clobber. So: blanket rules are dropped, granular rules are kept.
 *
 * Expansion mirrors `PermissionNext.fromConfig`: a bare action is `{"*": action}`, and
 * `~`/`$HOME` prefixes are expanded the way opencode expands them.
 */
export function userGranularRules(permission: WirePermissionConfig | undefined): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const [key, value] of Object.entries(permission ?? {})) {
    // a bare action is the blanket default for that key — dropped by the rule above
    if (typeof value === "string") continue;
    if (typeof value !== "object" || value === null) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (pattern === "*" || !ACTIONS.has(action)) continue;
      rules.push({ permission: key, pattern: expandPattern(pattern), action: action as PermissionAction });
    }
  }
  return rules;
}

/**
 * The session ruleset actually sent to `POST /session`, in evaluation order (opencode takes
 * the **last** match): Tide's mode rules, then the user's granular rules, then Tide's link
 * rules — so a read-only link's `edit: deny` always wins, W1's whole point.
 */
export function sessionRuleset(
  mode: RuntimeMode,
  interaction: InteractionMode,
  cwd: string,
  links: LinkedDir[] = [],
  userPermission?: WirePermissionConfig,
): PermissionRule[] {
  return [...permissionRuleset(mode, interaction), ...userGranularRules(userPermission), ...linkRules(cwd, links)];
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
