import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings, UserSettingsPatch } from "@tide/contracts";
import { ProviderCard } from "./ProviderCard.tsx";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { chooseOption, mockRpc, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useThreadDraft, type ThreadDraft } from "../thread/ProviderPicker.tsx";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function Draft() {
  const [draft] = useThreadDraft("claude");
  return <output>{JSON.stringify(draft satisfies ThreadDraft)}</output>;
}

/** A settings.set that merges like the server and remembers every patch. */
function echoServer(): UserSettingsPatch[] {
  const patches: UserSettingsPatch[] = [];
  let current: UserSettings = defaultUserSettings();
  mockRpc({
    "settings.set": ({ patch }: { patch: UserSettingsPatch }) => {
      patches.push(patch);
      current = {
        ...current,
        ...(patch.providerDefaults ? { providerDefaults: patch.providerDefaults } : {}),
        ...(patch.worktreeByDefault === undefined ? {} : { worktreeByDefault: patch.worktreeByDefault }),
      };
      return current;
    },
  });
  return patches;
}

describe("per-provider defaults", () => {
  it("saves the chosen model and mode on the server", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const patches = echoServer();
    render(<ProviderCard status={PROVIDER_FIXTURE[0]!} />);
    chooseOption("Claude Code default model", "Opus 4.6");
    await waitFor(() => expect(patches).toHaveLength(1));
    chooseOption("Claude Code default mode", /^Auto(?!-)/);

    await waitFor(() =>
      expect(useServerSettings.getState().settings.providerDefaults.claude).toEqual({ model: "opus-4-6", mode: "auto" }),
    );
    expect(patches[1]).toEqual({ providerDefaults: { claude: { model: "opus-4-6", mode: "auto" } } });
    expect(window.localStorage.getItem("tide.providerDefaults")).toBeNull();
  });

  it("lists the default modes in user language with their hints", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProviderCard status={PROVIDER_FIXTURE[0]!} />);
    expect(screen.getByRole("combobox", { name: "Claude Code default mode" }).textContent).toContain("Ask first");
    fireEvent.click(screen.getByRole("combobox", { name: "Claude Code default mode" }));
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("approval-required"))).toBe(false);
    expect(names.some((n) => n.includes("Auto-edit") && n.includes("asks before commands"))).toBe(true);
  });

  it("feeds useThreadDraft from the server defaults, overriding the harness default model", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<Draft />);
    // no saved default → the harness's own default model
    expect(JSON.parse(screen.getByRole("status").textContent ?? "{}")).toEqual({
      provider: "claude",
      providerId: "claude",
      model: "sonnet-4-6",
      effort: "",
      useWorktree: true,
    });

    cleanup();
    useServerSettings.setState({
      settings: {
        ...defaultUserSettings(),
        providerDefaults: { claude: { model: "opus-4-6", mode: "auto" } },
        worktreeByDefault: false,
      },
      loaded: true,
    });
    render(<Draft />);
    expect(JSON.parse(screen.getByRole("status").textContent ?? "{}")).toEqual({
      provider: "claude",
      providerId: "claude",
      model: "opus-4-6",
      effort: "",
      mode: "auto",
      useWorktree: false,
    });
  });
});
