import { describe, expect, it } from "vitest";
import type { RuntimeMode } from "@tide/contracts";
import { evaluate, grantCovers, permissionRuleset, replyFor, sessionRuleset, userRules, wildcardMatch } from "./permissions.ts";
import type { PermissionRule, WireConfigEntry } from "./wire.ts";

/** `Agent.Info.default` in `@opencode/schema` 2.0.27: allow-all plus `.env` asks. */
const AGENT_DEFAULT: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
];

/**
 * What core actually evaluates: `[...agent.permissions, ...session.permissions]`, where the
 * agent's list already ends with the user's config rules (core `opencode.config.agent` plugin).
 */
function effective(mode: RuntimeMode, user: PermissionRule[], action: string, resource: string): string {
  const session = sessionRuleset(mode, "default", "/work/repo", [], user);
  return evaluate(action, resource, [...AGENT_DEFAULT, ...user, ...session]);
}

describe("mode rules", () => {
  it("maps each runtime mode onto v2 action names", () => {
    expect(permissionRuleset("approval-required", "default")).toEqual([
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "ask" },
    ]);
    expect(permissionRuleset("auto-accept-edits", "default")).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(permissionRuleset("auto", "default").every((rule) => rule.effect === "allow")).toBe(true);
    expect(permissionRuleset("full-access", "default")).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });

  it("never adds allows in plan mode — the plan agent's own edit deny must survive", () => {
    expect(permissionRuleset("full-access", "plan")).toEqual([]);
    expect(permissionRuleset("approval-required", "plan").every((rule) => rule.effect === "ask")).toBe(true);
  });

  it("keeps the ask rules that give restrictive modes their meaning over the allow-all baseline", () => {
    for (const action of ["edit", "shell", "webfetch"]) expect(effective("approval-required", [], action, "x")).toBe("ask");
    expect(effective("auto-accept-edits", [], "edit", "src/a.ts")).toBe("allow");
    expect(effective("auto-accept-edits", [], "shell", "ls")).toBe("ask");
    expect(effective("approval-required", [], "read", "src/a.ts")).toBe("allow");
  });
});

describe("user rules are only ever narrowed", () => {
  const user: PermissionRule[] = [
    { action: "shell", resource: "*", effect: "allow" }, // blanket allow
    { action: "shell", resource: "rm *", effect: "deny" },
    { action: "edit", resource: "secrets/*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "ask" }, // blanket ask
  ];

  it("a user deny survives every mode, full-access included", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      expect(effective(mode, user, "shell", "rm -rf /")).toBe("deny");
      expect(effective(mode, user, "edit", "secrets/key.pem")).toBe("deny");
    }
  });

  it("a user blanket ask survives auto and full-access (the old driver dropped it)", () => {
    expect(effective("auto", user, "webfetch", "https://x")).toBe("ask");
    expect(effective("full-access", user, "webfetch", "https://x")).toBe("ask");
  });

  it("a stricter mode narrows a user allow", () => {
    expect(effective("approval-required", user, "shell", "git status")).toBe("ask");
    expect(effective("auto", user, "shell", "git status")).toBe("allow");
  });

  it("narrows rules written with a wildcard action too, without touching other actions", () => {
    const wide: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];
    expect(effective("approval-required", wide, "edit", "a.ts")).toBe("ask");
    expect(effective("approval-required", wide, "read", "a.ts")).toBe("allow");
  });

  it("collects the user's rules from config documents: top level, then the agent's own", () => {
    const entries: WireConfigEntry[] = [
      { type: "document", info: { permissions: [{ action: "shell", resource: "*", effect: "allow" }], agents: { review: { permissions: [{ action: "edit", resource: "~/x/*", effect: "ask" }] } } } },
      { type: "directory", path: "/home/u/.config/opencode" },
      { type: "document", info: { permissions: [{ action: "bogus" } as unknown as PermissionRule] } },
    ];
    expect(userRules(entries, "build")).toEqual([{ action: "shell", resource: "*", effect: "allow" }]);
    const review = userRules(entries, "review");
    expect(review).toHaveLength(2);
    expect(review[1]?.resource.endsWith("/x/*")).toBe(true);
    expect(review[1]?.resource.startsWith("~")).toBe(false);
    expect(userRules(undefined, "build")).toEqual([]);
  });
});

describe("approval replies", () => {
  it("never answers accept-for-session with the permanent `always`", () => {
    expect(replyFor("accept")).toBe("once");
    expect(replyFor("acceptForSession")).toBe("once");
    expect(replyFor("acceptAlways")).toBe("always");
    expect(replyFor("decline")).toBe("reject");
    expect(replyFor("cancel")).toBe("reject");
  });

  it("session grants cover later asks by action and save pattern", () => {
    const grants = [{ action: "shell", patterns: ["echo *"] }];
    expect(grantCovers(grants, "shell", ["echo hi"])).toBe(true);
    expect(grantCovers(grants, "shell", ["echo hi", "rm x"])).toBe(false);
    expect(grantCovers(grants, "edit", ["echo hi"])).toBe(false);
    expect(grantCovers(grants, "shell", [])).toBe(false);
  });

  it("matches like core's Wildcard (trailing ` *` also matches the bare command)", () => {
    expect(wildcardMatch("echo", "echo *")).toBe(true);
    expect(wildcardMatch("a/b/c", "a/*")).toBe(true);
    expect(wildcardMatch("ab", "a?")).toBe(true);
  });
});
