import { describe, expect, it } from "vitest";
import { PROVIDER_FIXTURE } from "../components/settings/fixtures.ts";
import { instanceOptions } from "../components/thread/ProviderPicker.tsx";
import { BUNDLED_PROVIDERS, PROVIDER_LABELS, SINGLE_ACCOUNT_KINDS, isProviderKind, kindOfId } from "./vocab.ts";

describe("Antigravity in the provider vocabulary", () => {
  it("is a bundled kind with a default instance, and single-account", () => {
    expect(BUNDLED_PROVIDERS).toContain("antigravity");
    expect(SINGLE_ACCOUNT_KINDS.has("antigravity")).toBe(true);
    expect(SINGLE_ACCOUNT_KINDS.has("codex")).toBe(false);
  });

  it("is recognised as a kind and as an instance id", () => {
    expect(isProviderKind("antigravity")).toBe(true);
    expect(kindOfId("antigravity")).toBe("antigravity");
    expect(isProviderKind("gemini")).toBe(false);
    expect(kindOfId("gemini")).toBeUndefined();
  });

  it("is offered by an all-scope picker with its label", () => {
    const options = instanceOptions(PROVIDER_FIXTURE, false, "all");
    const agy = options.find((o) => o.value === "antigravity");
    expect(PROVIDER_LABELS.antigravity).toBe("Antigravity");
    expect(agy?.label).toMatch(/^Antigravity/);
  });
});
