import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProvidersSection } from "./ProvidersSection.tsx";
import { PROVIDER_FIXTURE, LOGGED_OUT } from "./fixtures.ts";
import { ProviderCard } from "./ProviderCard.tsx";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { useTerminals } from "../../state/terminals.ts";
import { useUi } from "../../state/ui.ts";
import { setProvidersForTest } from "../../state/providers.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Providers", () => {
  it("renders one card per harness in a fixed order with display names", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProvidersSection />);
    const cards = screen.getAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Claude Code",
      "Codex",
      "OpenCode",
      "Pi",
    ]);
  });

  it("shows the status line of each harness", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProvidersSection />);
    expect(
      within(screen.getByLabelText("Claude Code")).getByText(/Installed · logged in · v2\.1\.251/),
    ).toBeDefined();
    const codex = within(screen.getByLabelText("Codex"));
    expect(codex.getByText(/Not installed/)).toBeDefined();
    expect(codex.getByText("driver not available in this build")).toBeDefined();
  });

  it("reads 'Installed · not logged in' when the CLI is there but logged out", () => {
    render(<ProviderCard status={LOGGED_OUT} />);
    expect(screen.getByText(/Installed · not logged in/)).toBeDefined();
    expect(screen.getByText("claude auth login")).toBeDefined();
    // no thread selected → the affordance copies instead of opening a terminal
    expect(screen.getByText("Copy login command")).toBeDefined();
  });

  it("runs the login command in a terminal of the selected thread", async () => {
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    const caller = mockRpc({
      "pty.create": () => ({ ptyId: "pty-1" }),
      "pty.write": () => ({ ok: true }),
    });
    render(<ProviderCard status={LOGGED_OUT} />);
    fireEvent.click(screen.getByText("Open terminal"));
    await vi.waitFor(() =>
      expect(caller).toHaveBeenCalledWith("pty.write", { ptyId: "pty-1", data: "claude auth login\n" }),
    );
    expect(useTerminals.getState().drawerOpen).toBe(true);
  });

  it("dims the capabilities a harness does not have", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProvidersSection />);
    const claude = within(screen.getByLabelText("Claude Code"));
    const pi = within(screen.getByLabelText("Pi"));
    expect(claude.getByLabelText("Claude Code capabilities").children).toHaveLength(7);
    for (const cap of ["planMode", "subagents", "mcp", "images", "resume", "contextUsage", "openInTerminal"]) {
      expect(claude.getByLabelText("Claude Code capabilities").querySelector(`[data-cap="${cap}"]`)?.getAttribute("data-on")).toBe("true");
      expect(pi.getByLabelText("Pi capabilities").querySelector(`[data-cap="${cap}"]`)?.getAttribute("data-on")).toBe("false");
    }
  });

  it("lists the models and marks the harness default", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProvidersSection />);
    const claude = within(screen.getByLabelText("Claude Code"));
    expect(claude.getByText("2 models")).toBeDefined();
    // once in the model list, once as an option of the default-model select
    expect(claude.getAllByText("Sonnet 4.6")).toHaveLength(2);
    expect(claude.getByText("opus")).toBeDefined();
    expect(claude.getByText("default")).toBeDefined();
    expect(within(screen.getByLabelText("Pi")).getByText("No models reported.")).toBeDefined();
  });

  it("states that Tide never stores provider credentials", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<ProvidersSection />);
    expect(screen.getByText(/Tide never stores provider credentials/)).toBeDefined();
  });

  it("re-probes with providers.list {refresh:true}", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const caller = mockRpc({ "providers.list": () => PROVIDER_FIXTURE });
    render(<ProvidersSection />);
    fireEvent.click(screen.getByText("Refresh all"));
    expect(caller).toHaveBeenCalledWith("providers.list", { refresh: true });
  });
});
