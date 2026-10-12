import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { ApprovalDecision, InteractionMode, LinkedDir, RuntimeMode } from "@tide/contracts";
import type { PermissionEffect, PermissionReply, PermissionRule, WireConfigEntry } from "./wire.ts";

/**
 * OpenCode 2 permission model (verified in `@opencode/core` 2.0.27, `src/permission.ts`):
 *  - a rule is `{ action, resource, effect }`; `evaluate` takes `rules.findLast(match)` and
 *    defaults to `ask`; `Wildcard.match` compiles `*` to `.*` (crossing `/`);
 *  - the ruleset a call is checked against is `[...agent.permissions, ...session.permissions]`,
 *    so session rules (the ones Tide sends) are evaluated **last**;
 *  - agents start from `Agent.Info.default` = `*:* allow` + `.env` asks, then the user's
 *    top-level `permissions` and the agent's own `agents.<id>.permissions` are appended;
 *  - a `deny` anywhere in that merged ruleset blocks before saved ("always") rules are read.
 *
 * Tide's run modes therefore have to be session rules (the agent baseline is allow-all), and
 * because they are evaluated last they would silently override the user's own rules. To keep
 * the user's config authoritative, the session ruleset *replays* the user's rules after the
 * mode rules, each followed by a copy narrowed by the mode: the net effect of every call is
 * the stricter of (what the user's config says, what the thread's mode says). Tide only ever
 * narrows — a user `deny` survives `full-access`, and `approval-required` still asks for a
 * call the user's config allows.
 *
 * Action names are v2's: `shell` (v1 `bash`), `edit` (v1 `write`/`patch`), `subagent` (v1
 * `task`) — the v1→v2 config migration in core maps exactly these.
 */
const MODE_RULES: Record<RuntimeMode, PermissionRule[]> = {
  "approval-required": [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "ask" },
  ],
  "auto-accept-edits": [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "ask" },
  ],
  auto: [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
  ],
  "full-access": [{ action: "*", resource: "*", effect: "allow" }],
};

const STRICTNESS: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };

function stricter(a: PermissionEffect, b: PermissionEffect): PermissionEffect {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** `Wildcard.match` from `@opencode/core` 2.0.27 (`src/util/wildcard.ts`). */
export function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

/** `Permission.evaluate`: last matching rule wins, `ask` when nothing matches. */
export function evaluate(action: string, resource: string, rules: PermissionRule[]): PermissionEffect {
  return rules.findLast((rule) => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))?.effect ?? "ask";
}

/**
 * The mode's rules. In plan mode the `plan` agent's own ruleset (`edit` denied outside its
 * plans dir) is what keeps planning safe; a mode `allow` would undo it, so only `ask` rules stay.
 */
export function permissionRuleset(mode: RuntimeMode, interaction: InteractionMode): PermissionRule[] {
  const rules = MODE_RULES[mode];
  return interaction === "plan" ? rules.filter((rule) => rule.effect !== "allow") : rules.map((rule) => ({ ...rule }));
}

/** `~`/`$HOME` expansion core applies to path actions when loading config permissions. */
function expandHome(rule: PermissionRule): PermissionRule {
  if (!["external_directory", "read", "edit"].includes(rule.action)) return rule;
  const home = homedir();
  const r = rule.resource;
  if (r === "~" || r === "$HOME") return { ...rule, resource: home };
  if (r.startsWith("~/")) return { ...rule, resource: `${home}/${r.slice(2)}` };
  if (r.startsWith("$HOME/")) return { ...rule, resource: `${home}/${r.slice(6)}` };
  return rule;
}

function isRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Partial<PermissionRule>;
  return typeof rule.action === "string" && typeof rule.resource === "string" && (rule.effect === "allow" || rule.effect === "ask" || rule.effect === "deny");
}

/**
 * The user's own rules for one agent, in the order core appends them: every config
 * document's top-level `permissions`, then that agent's `agents.<id>.permissions`.
 */
export function userRules(entries: WireConfigEntry[] | undefined, agent: string): PermissionRule[] {
  const docs = (entries ?? []).filter((entry) => entry.type === "document" && entry.info !== undefined);
  const top = docs.flatMap((entry) => entry.info?.permissions ?? []);
  const own = docs.flatMap((entry) => entry.info?.agents?.[agent]?.permissions ?? []);
  return [...top, ...own].filter(isRule).map(expandHome);
}

/**
 * Replays the user's rules, each followed (for every mode action it covers) by a copy whose
 * effect is the stricter of the user's and the mode's. Later user rules still override earlier
 * ones exactly as in opencode, and for a mode action the narrowed copy is what `findLast` sees.
 */
export function narrowedUserRules(user: PermissionRule[], mode: PermissionRule[]): PermissionRule[] {
  const narrowing = mode.filter((rule) => rule.action !== "*" && rule.effect !== "allow");
  const out: PermissionRule[] = [];
  for (const rule of user) {
    out.push(rule);
    for (const modeRule of narrowing) {
      if (!wildcardMatch(modeRule.action, rule.action)) continue;
      const effect = stricter(rule.effect, modeRule.effect);
      if (effect === rule.effect && rule.action === modeRule.action) continue;
      out.push({ action: modeRule.action, resource: rule.resource, effect });
    }
  }
  return out;
}

function linkGlobs(cwd: string, link: LinkedDir): string[] {
  const abs = resolve(link.path);
  const rel = relative(resolve(cwd), abs);
  return [abs, `${abs}/*`, ...(rel === "" ? [] : [rel, `${rel}/*`])];
}

/**
 * W1 linked repos. Verified against core 2.0.27 `file-access`: a path outside the location
 * is asked as `external_directory` with resource `<absolute dir>/*`, then `read`/`edit` with
 * the **absolute** path; a path inside it uses the path relative to the location. Both forms
 * are covered. Allows (read + external_directory) are emitted before the user's rules so a
 * user `deny` still wins; edit denies for read-only links are emitted last so nothing beats them.
 */
export function linkRules(cwd: string, links: LinkedDir[]): { allow: PermissionRule[]; deny: PermissionRule[] } {
  const allow: PermissionRule[] = [];
  const deny: PermissionRule[] = [];
  for (const link of links) {
    for (const resource of linkGlobs(cwd, link)) {
      allow.push({ action: "external_directory", resource, effect: "allow" });
      allow.push({ action: "read", resource, effect: "allow" });
      if (link.access !== "write") deny.push({ action: "edit", resource, effect: "deny" });
    }
  }
  return { allow, deny };
}

/**
 * The session ruleset Tide sends (`POST /api/session` / `PATCH /api/session/:id`), in
 * evaluation order: mode rules → link allows → the user's rules narrowed by the mode → link denies.
 */
export function sessionRuleset(
  mode: RuntimeMode,
  interaction: InteractionMode,
  cwd: string,
  links: LinkedDir[] = [],
  user: PermissionRule[] = [],
): PermissionRule[] {
  const modeRules = permissionRuleset(mode, interaction);
  const linked = linkRules(cwd, links);
  return [...modeRules, ...linked.allow, ...narrowedUserRules(user, modeRules), ...linked.deny];
}

/**
 * `acceptForSession` is emulated by the session (an in-memory grant that auto-answers later
 * asks with `once`), never `always`: core's `always` writes a project-wide saved rule
 * (`permission/saved`) that outlives the session and Tide.
 */
export function replyFor(decision: ApprovalDecision): PermissionReply {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return "once";
    case "acceptAlways":
      return "always";
    default:
      return "reject";
  }
}

/** A session-scoped grant: the asked action and the `save` patterns opencode proposed for it. */
export interface SessionGrant {
  action: string;
  patterns: string[];
}

export function grantCovers(grants: SessionGrant[], action: string, resources: string[]): boolean {
  if (resources.length === 0) return false;
  return resources.every((resource) => grants.some((grant) => grant.action === action && grant.patterns.some((pattern) => wildcardMatch(resource, pattern))));
}
