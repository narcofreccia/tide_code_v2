import { describe, expect, it } from "vitest";
import type { ProviderStatusDto } from "@tide/contracts";
import { isUsable, preferredProviderId, preferredProviderKind } from "./preferredProvider.ts";

const caps = { planMode: true, subagents: true, mcp: true, images: true, resume: true, contextUsage: true, openInTerminal: true };
const p = (id: string, installed: boolean, loggedIn: boolean): ProviderStatusDto => ({
  id,
  kind: (id.startsWith("acp:") ? "acp" : id.split(":")[0]) as ProviderStatusDto["kind"],
  label: id,
  installed,
  loggedIn,
  models: [],
  caps,
});

describe("preferredProviderId", () => {
  const cases: { name: string; roster: ProviderStatusDto[]; preferred?: string; scope?: "all" | "bundled"; want: string }[] = [
    { name: "empty roster keeps the preference (still loading)", roster: [], preferred: "codex", want: "codex" },
    { name: "empty roster, no preference → the first bundled kind", roster: [], want: "claude" },
    { name: "usable preference wins", roster: [p("claude", true, true), p("codex", true, true)], preferred: "codex", want: "codex" },
    { name: "unusable preference → first usable in roster order", roster: [p("claude", false, false), p("codex", true, false), p("pi", true, true)], preferred: "claude", want: "pi" },
    { name: "Codex-only user without a preference gets Codex", roster: [p("claude", false, false), p("codex", true, true)], want: "codex" },
    { name: "an ACP agent counts in scope all", roster: [p("claude", false, false), p("acp:gemini", true, true)], want: "acp:gemini" },
    { name: "an ACP agent does not count for bundled-only surfaces", roster: [p("claude", false, false), p("acp:gemini", true, true)], scope: "bundled", want: "claude" },
    { name: "an extra account counts in scope all", roster: [p("claude", true, false), p("claude:work", true, true)], want: "claude:work" },
    { name: "nothing usable → the preference, so the form can say what to fix", roster: [p("claude", false, false), p("codex", true, false)], preferred: "codex", want: "codex" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(preferredProviderId(c.roster, c.preferred, c.scope)).toBe(c.want);
    });
  }

  it("types the bundled choice as a kind", () => {
    expect(preferredProviderKind([p("claude", false, false), p("opencode", true, true)])).toBe("opencode");
  });

  it("isUsable needs installed and logged in", () => {
    expect(isUsable(p("claude", true, true))).toBe(true);
    expect(isUsable(p("claude", true, false))).toBe(false);
    expect(isUsable(undefined)).toBe(false);
  });
});
