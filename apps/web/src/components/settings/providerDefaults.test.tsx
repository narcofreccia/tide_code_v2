import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProviderCard } from "./ProviderCard.tsx";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { chooseOption, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useThreadDraft, type ThreadDraft } from "../thread/ProviderPicker.tsx";
import { PROVIDER_DEFAULTS_STORAGE_KEY, useProviderDefaults } from "../../state/settings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function Draft() {
  const [draft] = useThreadDraft("claude");
  return <output>{JSON.stringify(draft satisfies ThreadDraft)}</output>;
}

describe("per-provider defaults", () => {
  it("persists the chosen model and mode under tide.providerDefaults", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProviderCard status={PROVIDER_FIXTURE[0]!} />);
    chooseOption("Claude Code default model", "Opus 4.6");
    chooseOption("Claude Code default mode", "auto");

    expect(useProviderDefaults.getState().defaults.claude).toEqual({ model: "opus-4-6", mode: "auto" });
    const stored = JSON.parse(window.localStorage.getItem(PROVIDER_DEFAULTS_STORAGE_KEY) ?? "{}") as {
      state: { defaults: Record<string, unknown> };
    };
    expect(stored.state.defaults.claude).toEqual({ model: "opus-4-6", mode: "auto" });
  });

  it("feeds useThreadDraft, overriding the harness default model", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<Draft />);
    // no saved default → the harness's own default model
    expect(JSON.parse(screen.getByRole("status").textContent ?? "{}")).toEqual({
      provider: "claude",
      model: "sonnet-4-6",
      useWorktree: true,
    });

    cleanup();
    useProviderDefaults.getState().setProviderDefault("claude", { model: "opus-4-6", mode: "auto" });
    render(<Draft />);
    expect(JSON.parse(screen.getByRole("status").textContent ?? "{}")).toEqual({
      provider: "claude",
      model: "opus-4-6",
      mode: "auto",
      useWorktree: true,
    });
  });
});
