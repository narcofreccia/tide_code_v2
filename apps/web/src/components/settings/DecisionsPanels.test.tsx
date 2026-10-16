import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProviderStatusDto, UserSettings } from "@tide/contracts";
import { DecisionsFallback } from "./DecisionsFallback.tsx";
import { DecisionsTuning } from "./DecisionsTuning.tsx";
import { DecisionsSpend } from "./DecisionsSpend.tsx";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { defaultDecisionsSettings, defaultUserSettings } from "../../state/serverSettings.ts";
import { useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const echo = (): UserSettings => defaultUserSettings();

function seed(decisions: Partial<UserSettings["decisions"]> = {}): void {
  useServerSettings.setState({ settings: { ...defaultUserSettings(), decisions: { ...defaultDecisionsSettings(), ...decisions } }, loaded: true });
}

const ONE_SHOT: ProviderStatusDto[] = PROVIDER_FIXTURE.map((p) =>
  p.kind === "claude" ? { ...p, caps: { ...p.caps, oneShot: true } } : p,
);

describe("Decisions › Fallback", () => {
  it("picks a harness model, then None clears it", () => {
    const rpc = mockRpc({ "settings.set": echo });
    setProvidersForTest(ONE_SHOT);
    seed();
    render(<DecisionsFallback />);
    fireEvent.click(screen.getByLabelText("Fallback agent"));
    const list = screen.getByRole("listbox");
    expect(within(list).queryByRole("option", { name: /Codex/ })).toBeNull();
    fireEvent.click(within(list).getByRole("option", { name: /Claude/ }));
    expect(rpc).toHaveBeenCalledWith("settings.set", {
      patch: { decisions: { fallback: { provider: "claude", model: "sonnet-4-6" } } },
    });

    seed({ fallback: { provider: "claude", model: "sonnet-4-6" } });
    fireEvent.click(screen.getByLabelText("Fallback agent"));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /None/ }));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { fallback: null } } });
  });
});

describe("Decisions › Tuning", () => {
  it("keeps low below high and patches the gray zone", () => {
    const rpc = mockRpc({ "settings.set": echo });
    seed({ grayZone: { low: 0.6, high: 0.85 } });
    render(<DecisionsTuning />);
    fireEvent.change(screen.getByLabelText("Gray zone low"), { target: { value: "0.9" } });
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { grayZone: { low: 0.9, high: 0.95 } } } });
    fireEvent.change(screen.getByLabelText("Gray zone high"), { target: { value: "0.5" } });
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { grayZone: { high: 0.5, low: 0.45 } } } });
  });

  it("toggles a site and the experts opt-in", () => {
    const rpc = mockRpc({ "settings.set": echo });
    seed();
    render(<DecisionsTuning />);
    fireEvent.click(screen.getByLabelText("Handoff"));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { sites: { handoff: false } } } });
    fireEvent.click(screen.getByLabelText("Advance experts automatically when converged"));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { expertsAutoAdvance: true } } });
  });
});

describe("Decisions › Spend", () => {
  it("renders today, by-site and collapsed recent verdicts from decisions.stats", async () => {
    mockRpc({
      "decisions.stats": () => ({
        today: { jev: { calls: 3, tokens: 1200, usd: 0.01 }, fallback: { calls: 1, tokens: 400, usd: 0 } },
        bySite: { approvals: { calls: 4, tokens: 1600, usd: 0.01 } },
        recent: [
          { at: 1, site: "approvals", source: "fallback", questionId: "q", label: "routine", confidence: 0.7, tokens: 400, elapsedMs: 820 },
          { at: 2, site: "stuck", source: "jev", questionId: "q2", confidence: 0.9, tokens: 10, elapsedMs: 40, error: "timeout" },
        ],
      }),
    });
    render(<DecisionsSpend />);
    const today = await screen.findByRole("table", { name: "Today" });
    expect(within(today).getByText("Jev")).toBeDefined();
    expect(within(today).getByText("n/a")).toBeDefined();
    expect(within(screen.getByRole("table", { name: "By site" })).getByText("approvals")).toBeDefined();
    expect(screen.queryByRole("table", { name: "Recent verdicts" })).toBeNull();
    fireEvent.click(screen.getByText(/Recent verdicts/));
    const recent = screen.getByRole("table", { name: "Recent verdicts" });
    expect(within(recent).getByText("routine")).toBeDefined();
    expect(within(recent).getByText("timeout")).toBeDefined();
  });

  it("shows the empty state", async () => {
    mockRpc({ "decisions.stats": () => ({ today: { jev: { calls: 0, tokens: 0, usd: 0 }, fallback: { calls: 0, tokens: 0, usd: 0 } }, bySite: {}, recent: [] }) });
    render(<DecisionsSpend />);
    await act(async () => {});
    expect(screen.getByText("No verdicts yet.")).toBeDefined();
  });
});
