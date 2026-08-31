import { describe, expect, it } from "vitest";
import { permissionRuleset, replyFor } from "./permissions.ts";

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

  it("maps decisions onto opencode's three replies", () => {
    expect(replyFor("accept")).toBe("once");
    expect(replyFor("acceptForSession")).toBe("always");
    expect(replyFor("acceptAlways")).toBe("always");
    expect(replyFor("decline")).toBe("reject");
    expect(replyFor("cancel")).toBe("reject");
  });
});
