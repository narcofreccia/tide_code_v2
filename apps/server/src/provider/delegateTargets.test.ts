import { describe, expect, it } from "vitest";
import { delegateTargetsHint } from "./delegateTargets.ts";

const registry = {
  list: () => ["claude", "opencode", "codex:work"],
  kindOf: (id: string) => (id === "codex:work" ? "codex" : id),
  labelOf: (id: string) => (id === "codex:work" ? "Work account" : undefined),
};

describe("delegateTargetsHint", () => {
  it("names every configured harness with its default model", () => {
    const hint = delegateTargetsHint(registry, { claude: { model: "opus" }, opencode: { model: "opencode/glm-5.3-flash-free" } });
    expect(hint).toContain("claude (default model opus)");
    expect(hint).toContain("opencode (default model opencode/glm-5.3-flash-free)");
    expect(hint).toContain("codex providerId codex:work (Work account)");
  });
  it("is empty without harnesses", () => {
    expect(delegateTargetsHint({ list: () => [], kindOf: () => undefined, labelOf: () => undefined }, {})).toBeUndefined();
  });
});
