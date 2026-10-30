import { describe, expect, it } from "vitest";
import type { RuntimeMode } from "@tide/contracts";
import { effortSelector, modelSelector } from "../src/models.ts";
import { decisionOption, modeSelector, planModeId, planPermission, targetModeId } from "../src/permissions.ts";
import type { AcpNewSessionResult, AcpPermissionOption } from "../src/types.ts";
import { loadFixture } from "./fake-agent.ts";

const OPTIONS: AcpPermissionOption[] = [
  { optionId: "once", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
];

function sessionResult(fixture: string): AcpNewSessionResult {
  const line = loadFixture(fixture).find((entry) => entry._dir !== "c2a" && entry.id === 1 && entry.result !== undefined);
  return line?.result as AcpNewSessionResult;
}

describe("runtime mode → permission answers", () => {
  const table: [RuntimeMode, string, string][] = [
    ["approval-required", "edit", "forward"],
    ["approval-required", "read", "forward"],
    ["auto-accept-edits", "edit", "once"],
    ["auto-accept-edits", "move", "once"],
    ["auto-accept-edits", "delete", "once"],
    ["auto-accept-edits", "read", "once"],
    ["auto-accept-edits", "search", "once"],
    ["auto-accept-edits", "fetch", "once"],
    ["auto-accept-edits", "execute", "forward"],
    ["auto-accept-edits", "other", "forward"],
    ["auto", "execute", "once"],
    ["auto", "other", "once"],
    ["full-access", "execute", "always"],
    ["full-access", "edit", "always"],
  ];
  it.each(table)("%s + %s → %s", (mode, kind, expected) => {
    const plan = planPermission(mode, kind, OPTIONS);
    expect(plan.kind === "forward" ? "forward" : plan.optionId).toBe(expected);
  });

  it("auto modes keep an audit row; auto-accept-edits does not", () => {
    expect(planPermission("auto", "execute", OPTIONS)).toEqual({ kind: "auto", optionId: "once", audit: true });
    expect(planPermission("auto-accept-edits", "edit", OPTIONS)).toEqual({ kind: "auto", optionId: "once", audit: false });
  });

  it("full-access falls back to allow_once; no allow option at all is forwarded", () => {
    expect(planPermission("full-access", "execute", OPTIONS.filter((o) => o.kind !== "allow_always"))).toMatchObject({ optionId: "once" });
    expect(planPermission("full-access", "execute", OPTIONS.filter((o) => !o.kind.startsWith("allow")))).toEqual({ kind: "forward" });
  });

  it("a request without a kind is forwarded under auto-accept-edits", () => {
    expect(planPermission("auto-accept-edits", undefined, OPTIONS)).toEqual({ kind: "forward" });
  });
});

describe("Tide decision → option", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "no"],
    ["cancel", undefined],
  ] as const)("%s → %s", (decision, expected) => {
    expect(decisionOption(decision, OPTIONS)).toBe(expected);
  });

  it("acceptForSession falls back to allow_once; decline to reject_always", () => {
    expect(decisionOption("acceptForSession", [OPTIONS[0]!, OPTIONS[3]!])).toBe("once");
    expect(decisionOption("decline", [OPTIONS[0]!, OPTIONS[3]!])).toBe("never");
  });
});

describe("agent modes", () => {
  it("prefers the category:mode config option over legacy modes", () => {
    const result = sessionResult("synthetic/init-config");
    const selector = modeSelector(result.modes, result.configOptions);
    expect(selector).toMatchObject({ kind: "config", configId: "mode", current: "default" });
    expect(planModeId(selector)).toBe("plan");
  });

  it("matches runtime modes by id or name, never a hardcoded id", () => {
    const result = sessionResult("synthetic/init-config");
    const selector = modeSelector(result.modes, result.configOptions);
    expect(targetModeId(selector, "default", "full-access", "default")).toBe("bypassPermissions");
    expect(targetModeId(selector, "default", "auto-accept-edits", "default")).toBe("acceptEdits");
    expect(targetModeId(selector, "default", "approval-required", "default")).toBe("default");
    expect(targetModeId(selector, "default", "auto", "default")).toBe("default");
    expect(targetModeId(selector, "default", "full-access", "plan")).toBe("plan");
  });

  it("OpenCode 1.1 (recorded) exposes build/plan through legacy modes; plan is found, full-access has no match", () => {
    const result = sessionResult("opencode-acp-1.1/init");
    const selector = modeSelector(result.modes, result.configOptions);
    expect(selector).toMatchObject({ kind: "modes", current: "build" });
    expect(planModeId(selector)).toBe("plan");
    expect(targetModeId(selector, "build", "full-access", "default")).toBe("build");
  });

  it("no modes at all → no selector", () => {
    expect(modeSelector(undefined, [])).toBeUndefined();
    expect(targetModeId(undefined, undefined, "full-access", "plan")).toBeUndefined();
  });
});

describe("models and effort", () => {
  it("configOptions: grouped model options flatten; thought_level becomes efforts on every model", () => {
    const result = sessionResult("synthetic/init-config");
    const selector = modelSelector(result.configOptions, result.models);
    expect(selector?.kind).toBe("config");
    expect(selector?.models.map((m) => [m.id, m.label, m.default])).toEqual([
      ["pro", "Pro", true],
      ["flash", "Flash", false],
    ]);
    expect(selector?.models[1]?.efforts).toEqual([
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", default: true },
      { id: "high", label: "High" },
    ]);
    expect(effortSelector(result.configOptions)).toMatchObject({ configId: "thinking", current: "medium" });
  });

  it("config defaultModel overrides the agent's current model as the default", () => {
    const result = sessionResult("synthetic/init-config");
    expect(modelSelector(result.configOptions, null, "flash")?.models.find((m) => m.default)?.id).toBe("flash");
  });

  it("OpenCode 1.1 (recorded): legacy models block, no efforts", () => {
    const result = sessionResult("opencode-acp-1.1/init");
    const selector = modelSelector(result.configOptions, result.models);
    expect(selector?.kind).toBe("legacy");
    expect(selector?.current).toBe("opencode/big-pickle");
    expect(selector?.models.length).toBeGreaterThan(10);
    expect(selector?.models.every((model) => model.efforts === undefined)).toBe(true);
  });

  it("nothing reported → no selector", () => {
    expect(modelSelector(undefined, undefined)).toBeUndefined();
    expect(effortSelector(undefined)).toBeUndefined();
  });
});
