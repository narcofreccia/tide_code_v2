import { describe, expect, it } from "vitest";
import type { LinkedDir } from "@tide/contracts";
import { evaluate, linkRules, sessionRuleset } from "./permissions.ts";
import type { PermissionRule } from "./wire.ts";

const links: LinkedDir[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra/", label: "infra", access: "read" },
];

const BASE: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];

/**
 * Core 2.0.27 `file-access`: outside the location a path is asked as `external_directory`
 * (resource `<abs dir>/*`) and then `read`/`edit` with the absolute path; inside it, relative.
 */
describe("opencode linked-repo ruleset", () => {
  const rules = [...BASE, ...sessionRuleset("auto-accept-edits", "default", "/work/repo", links)];

  it("allows reading under both a write link and a read-only link", () => {
    expect(evaluate("external_directory", "/repos/infra/modules/*", rules)).toBe("allow");
    expect(evaluate("external_directory", "/repos/frontend/src/*", rules)).toBe("allow");
    expect(evaluate("read", "/repos/infra/main.tf", rules)).toBe("allow");
  });

  it("denies edits under a read-only link, absolute and relative", () => {
    expect(evaluate("edit", "/repos/infra/main.tf", rules)).toBe("deny");
    expect(evaluate("edit", "../../repos/infra/main.tf", rules)).toBe("deny");
  });

  it("leaves edits under a write link to the run mode", () => {
    expect(evaluate("edit", "/repos/frontend/src/app.tsx", rules)).toBe("allow");
  });

  it("does not change behaviour inside the thread's own cwd", () => {
    expect(evaluate("edit", "src/app.ts", rules)).toBe("allow");
    expect(evaluate("shell", "rm -rf /", rules)).toBe("ask");
  });

  it("a read-only link's edit deny beats a user's allow on the same path", () => {
    const user: PermissionRule[] = [{ action: "edit", resource: "/repos/infra/*", effect: "allow" }];
    const merged = [...BASE, ...user, ...sessionRuleset("full-access", "default", "/work/repo", links, user)];
    expect(evaluate("edit", "/repos/infra/main.tf", merged)).toBe("deny");
  });

  it("a user's read deny inside a link still wins over the link's read allow", () => {
    const user: PermissionRule[] = [{ action: "read", resource: "/repos/frontend/.env*", effect: "deny" }];
    const merged = [...BASE, ...user, ...sessionRuleset("auto", "default", "/work/repo", links, user)];
    expect(evaluate("read", "/repos/frontend/.env.local", merged)).toBe("deny");
    expect(evaluate("read", "/repos/frontend/src/a.ts", merged)).toBe("allow");
  });

  it("never widens edits — link rules only add read allows and edit denies", () => {
    const { allow, deny } = linkRules("/work/repo", links);
    expect(allow.every((rule) => rule.action !== "edit")).toBe(true);
    expect(deny.every((rule) => rule.action === "edit" && rule.effect === "deny")).toBe(true);
    const plan = sessionRuleset("full-access", "plan", "/work/repo", links);
    expect(plan.some((rule) => rule.action === "edit" && rule.effect === "allow")).toBe(false);
  });
});
