import { describe, expect, it } from "vitest";
import type { LinkedDir } from "@tide/contracts";
import { linkRules, sessionRuleset } from "./permissions.ts";
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
