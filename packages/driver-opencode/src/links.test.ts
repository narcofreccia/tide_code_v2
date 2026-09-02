import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LinkedDir } from "@tide/contracts";
import { linkRules, sessionRuleset, userGranularRules } from "./permissions.ts";
import type { PermissionRule } from "./wire.ts";

const links: LinkedDir[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra/", label: "infra", access: "read" },
];

/**
 * opencode's own evaluator, reimplemented from opencode 1.1.36 `src/permission/next.ts`,
 * so these tests assert the behaviour the harness will actually produce rather than the
 * shape of our rule objects: `Wildcard.match` compiles `*` to `.*` (crossing `/`), and
 * `evaluate` takes the **last** matching rule, defaulting to `ask`.
 */
const match = (str: string, pattern: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(str);

const evaluate = (permission: string, pattern: string, ruleset: PermissionRule[]): "allow" | "deny" | "ask" =>
  ruleset.findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern))?.action ?? "ask";

describe("user config vs Tide's mode rules", () => {
  // The user's own opencode.json, as `GET /config` serves its `permission` block.
  const userConfig = {
    bash: { "git *": "allow" as const, "rm -rf *": "deny" as const },
    edit: "allow" as const, // a blanket default — deliberately not replayed
    webfetch: { "*": "allow" as const }, // blanket in map form — also not replayed
  };

  it("keeps a user's granular allow alive under approval-required", () => {
    const rules = sessionRuleset("approval-required", "default", "/work/repo", [], userConfig);
    expect(evaluate("bash", "git status", rules)).toBe("allow");
    expect(evaluate("bash", "rm -rf /", rules)).toBe("deny");
    // …while the mode still governs everything the user was not specific about
    expect(evaluate("bash", "curl example.com", rules)).toBe("ask");
  });

  it("ignores the user's blanket rules — otherwise the thread's mode selector would be a lie", () => {
    const rules = sessionRuleset("approval-required", "default", "/work/repo", [], userConfig);
    expect(rules.some((rule) => rule.pattern === "*" && rule.action === "allow")).toBe(false);
    expect(evaluate("edit", "src/app.ts", rules)).toBe("ask");
    expect(evaluate("webfetch", "https://example.com", rules)).toBe("ask");
  });

  it("puts link rules last, so a read-only link beats a user's granular allow on the same path", () => {
    const rules = sessionRuleset("auto", "default", "/work/repo", links, { edit: { "/repos/infra/*": "allow" as const } });
    expect(evaluate("edit", "/repos/infra/main.tf", rules)).toBe("deny");
    expect(evaluate("edit", "../../repos/infra/main.tf", rules)).toBe("deny");
  });

  it("expands ~ and $HOME the way opencode does, and skips junk actions", () => {
    const rules = userGranularRules({ read: { "~/secrets/*": "deny", "$HOME/keys/*": "deny", "ok/*": "nonsense" } as never });
    expect(rules.map((rule) => rule.pattern)).toEqual([`${homedir()}/secrets/*`, `${homedir()}/keys/*`]);
  });

  it("degrades to the mode rules alone when the config is unavailable", () => {
    expect(sessionRuleset("auto", "default", "/work/repo", [], undefined)).toEqual(sessionRuleset("auto", "default", "/work/repo", []));
    expect(userGranularRules(undefined)).toEqual([]);
  });
});

describe("opencode linked-repo ruleset", () => {
  const rules = sessionRuleset("auto-accept-edits", "default", "/work/repo", links);

  it("allows reading under both a write link and a read-only link", () => {
    // opencode gates any path outside the project behind `external_directory`, asked with
    // the absolute glob of the target's parent directory.
    expect(evaluate("external_directory", "/repos/infra/modules/*", rules)).toBe("allow");
    expect(evaluate("external_directory", "/repos/frontend/src/*", rules)).toBe("allow");
    expect(evaluate("read", "/repos/infra/main.tf", rules)).toBe("allow");
    expect(evaluate("read", "/repos/frontend/src/app.tsx", rules)).toBe("allow");
  });

  it("denies edits under a read-only link, in both the relative and absolute form", () => {
    // the `edit` permission is asked with the path relative to the worktree
    expect(evaluate("edit", "../../repos/infra/main.tf", rules)).toBe("deny");
    expect(evaluate("edit", "/repos/infra/main.tf", rules)).toBe("deny");
  });

  it("leaves edits under a write link to the run mode", () => {
    expect(evaluate("edit", "../../repos/frontend/src/app.tsx", rules)).toBe("allow");
    expect(evaluate("edit", "/repos/frontend/src/app.tsx", rules)).toBe("allow");
  });

  it("does not change behaviour inside the thread's own cwd", () => {
    expect(evaluate("edit", "src/app.ts", rules)).toBe("allow");
    expect(evaluate("bash", "rm -rf /", rules)).toBe("ask");
    expect(sessionRuleset("approval-required", "default", "/work/repo", []).every((rule) => rule.pattern === "*")).toBe(true);
  });

  it("never widens edit permissions — link rules only ever add allow-read and deny-edit", () => {
    expect(linkRules("/work/repo", links).some((rule) => rule.permission === "edit" && rule.action !== "deny")).toBe(false);
    // …so a plan-mode session (which keeps no allow rules) is not loosened by links either
    const plan = sessionRuleset("full-access", "plan", "/work/repo", links);
    expect(plan.some((rule) => rule.permission === "edit" && rule.action === "allow")).toBe(false);
    expect(evaluate("edit", "/repos/infra/main.tf", plan)).toBe("deny");
  });
});
