import { describe, expect, it } from "vitest";
import { permissionRuleset, replyFor } from "./permissions.ts";
import type { PermissionRule } from "./wire.ts";

/** `Wildcard.match` from opencode 1.1.36 `src/util/wildcard.ts`. */
const match = (str: string, pattern: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(str);

describe("permission mapping", () => {
  it("maps each runtime mode onto an opencode session ruleset", () => {
    expect(permissionRuleset("approval-required", "default")).toEqual([
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "webfetch", pattern: "*", action: "ask" },
    ]);
    expect(permissionRuleset("auto-accept-edits", "default")).toContainEqual({ permission: "edit", pattern: "*", action: "allow" });
    expect(permissionRuleset("auto-accept-edits", "default")).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(permissionRuleset("auto", "default").every((rule) => rule.action === "allow")).toBe(true);
    expect(permissionRuleset("full-access", "default")).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  it("never widens permissions in plan mode — the plan agent's own denies must survive", () => {
    expect(permissionRuleset("full-access", "plan")).toEqual([]);
    expect(permissionRuleset("auto", "plan")).toEqual([]);
    expect(permissionRuleset("approval-required", "plan").every((rule) => rule.action === "ask")).toBe(true);
  });

  /**
   * opencode 1.1.36's built-in agents start from `fromConfig({"*": "allow", …})` and the
   * user's `opencode.json` is merged after it, so **an empty session ruleset means "allow
   * everything"**, not "ask". These assertions are the regression guard: dropping the `ask`
   * rules would silently turn approval-required and auto-accept-edits into full auto.
   */
  it("keeps the ask rules that give the restrictive modes their meaning", () => {
    const agentBaseline: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
    const evaluate = (permission: string, ...rulesets: PermissionRule[][]): string =>
      rulesets.flat().findLast((rule) => match(permission, rule.permission))?.action ?? "ask";

    for (const permission of ["edit", "bash", "webfetch"]) {
      expect(evaluate(permission, agentBaseline, permissionRuleset("approval-required", "default"))).toBe("ask");
    }
    expect(evaluate("edit", agentBaseline, permissionRuleset("auto-accept-edits", "default"))).toBe("allow");
    expect(evaluate("bash", agentBaseline, permissionRuleset("auto-accept-edits", "default"))).toBe("ask");
    // …and permissions Tide says nothing about keep whatever the agent and user config decided
    expect(evaluate("read", agentBaseline, permissionRuleset("approval-required", "default"))).toBe("allow");
  });

  it("uses `*` as a wildcard permission key for full access, the way opencode's own defaults do", () => {
    // `PermissionNext.Rule.permission` is `z.string()` and `evaluate` matches it with
    // `Wildcard.match(asked, rule.permission)` (opencode 1.1.36), so `*` is a legal key.
    const rules = permissionRuleset("full-access", "default");
    expect(rules).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
    for (const permission of ["edit", "bash", "webfetch", "external_directory", "read", "glob", "grep", "list"]) {
      expect(rules.some((rule) => match(permission, rule.permission))).toBe(true);
    }
  });

  it("maps decisions onto opencode's three replies", () => {
    expect(replyFor("accept")).toBe("once");
    expect(replyFor("acceptForSession")).toBe("always");
    expect(replyFor("acceptAlways")).toBe("always");
    expect(replyFor("decline")).toBe("reject");
    expect(replyFor("cancel")).toBe("reject");
  });
});
