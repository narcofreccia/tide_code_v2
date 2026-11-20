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
  it("lists the model ids each harness reported, capped, and says to use them verbatim", () => {
    const many = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const hint = delegateTargetsHint(
      { ...registry, cachedModels: (id: string) => (id === "claude" ? ["opus", "sonnet", "claude-opus-5"] : id === "codex:work" ? many : undefined) },
      { claude: { model: "opus" } },
    );
    expect(hint).toContain("claude (default model opus, models opus, sonnet, claude-opus-5)");
    expect(hint).toContain("codex providerId codex:work (Work account) (models m0, m1,");
    expect(hint).toContain("m15, …)");
    expect(hint).not.toContain("m16");
    expect(hint).toContain("opencode;");
    expect(hint).toContain("exactly as listed");
  });
  it("is empty without harnesses", () => {
    expect(delegateTargetsHint({ list: () => [], kindOf: () => undefined, labelOf: () => undefined }, {})).toBeUndefined();
  });
});
