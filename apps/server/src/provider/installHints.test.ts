import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_PROFILE } from "@tide/driver-acp";
import { localAgent } from "./acpRegistry.ts";
import { HARNESS_INSTALLS, acpInstallHint, installHintFor } from "./installHints.ts";

describe("install hints", () => {
  it("gives every bundled harness a command and a docs page", () => {
    for (const kind of ["claude", "codex", "opencode", "pi"] as const) {
      const hint = installHintFor(kind);
      expect(hint?.command).toBe(HARNESS_INSTALLS[kind].command);
      expect(hint?.url).toMatch(/^https:\/\//);
    }
    expect(installHintFor("codex")).toEqual({ command: "npm i -g @openai/codex", url: "https://github.com/openai/codex" });
  });

  it("has no table entry for ACP agents", () => {
    expect(installHintFor("acp")).toBeUndefined();
  });

  it("points an ACP agent at its website, else its repository, else nothing", () => {
    const base = { id: "a", name: "A", distribution: {} };
    expect(acpInstallHint({ ...base, website: "https://a.dev", repository: "https://github.com/a/a" })).toEqual({ url: "https://a.dev" });
    expect(acpInstallHint({ ...base, repository: "https://github.com/a/a" })).toEqual({ url: "https://github.com/a/a" });
    expect(acpInstallHint(base)).toBeUndefined();
    expect(acpInstallHint(undefined)).toBeUndefined();
  });

  it("points Antigravity at Google's site and says where to get the CLI", () => {
    const agy = localAgent(ANTIGRAVITY_PROFILE);
    expect(acpInstallHint(agy)).toEqual({ url: "https://antigravity.google" });
    expect(agy.description).toMatch(/Antigravity download page.*`agy`.*sign in/);
  });
});
