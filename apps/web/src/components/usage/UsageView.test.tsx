import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UsageSummary } from "@tide/contracts";
import { UsageView } from "./UsageView.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { mockRoutedRpc, resetEnvironments, twoEnvironments } from "../prs/testFixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetEnvironments();
});

function summary(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    since: 0,
    until: 1,
    pricingVersion: "2026-10",
    notes: ["Codex reports no cost; shown as an estimate"],
    days: [
      { day: "2026-10-28", tokens: 1000 },
      { day: "2026-10-29", tokens: 500 },
    ],
    rows: [
      { provider: "claude", model: "opus", source: "tide", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300, turns: 4, costUsd: 1.5 },
      { provider: "claude", model: "opus", source: "external", inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 2, costUsd: 0.25 },
      { provider: "codex", model: "gpt-5", source: "tide", inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, estimatedUsd: 0.12 },
    ],
    ...patch,
  };
}

describe("UsageView", () => {
  it("tabulates harness → model with sources, subtotals, totals and labelled estimates", async () => {
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({ "usage.summary": () => summary(), "settings.set": () => useServerSettings.getState().settings });
    render(<UsageView />);
    const table = await screen.findByRole("table");
    expect(rpc).toHaveBeenCalledWith("usage.summary", expect.objectContaining({ includeExternal: true }));

    const total = within(table).getByRole("rowheader", { name: "Total" }).closest("tr");
    // in 1.8k · out 330 · cache read 5.0k · cache write 300 · 7 turns · reported $1.75 · estimated ≈$0.12
    expect([...(total?.querySelectorAll("td") ?? [])].map((td) => td.textContent)).toEqual([
      "", "1.8k", "330", "5.0k", "300", "7", "$1.75", "≈$0.12",
    ]);
    const claude = within(table).getByRole("rowheader", { name: "Claude Code" }).closest("tr");
    expect(claude?.textContent).toContain("$1.75");
    expect(within(table).getByText("outside Tide (harness logs)")).toBeDefined();
    expect(within(table).getAllByText("Tide")).toHaveLength(2);
    // codex reported nothing: the reported cell is a dash, the estimate is marked ≈
    expect(within(table).getAllByText("≈$0.12").length).toBeGreaterThan(0);

    expect(screen.getByText("Reported = what the harness said it cost. Estimated = Tide's price table 2026-10, not your bill.")).toBeDefined();
    expect(screen.getByText("Codex reports no cost; shown as an estimate")).toBeDefined();
    expect(screen.getAllByRole("listitem", { name: /2026-10-2\d: / })).toHaveLength(2);
  });

  it("changes the window and toggles harness logs", async () => {
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({
      "usage.summary": () => summary(),
      "settings.set": () => ({ ...useServerSettings.getState().settings }),
    });
    render(<UsageView />);
    await screen.findByRole("table");
    const first = rpc.mock.calls.find(([m]) => m === "usage.summary")?.[1] as { since: number; until: number };
    expect(Math.round((first.until - first.since) / 86_400_000)).toBe(30);

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "7 d" }));
    });
    const last = rpc.mock.calls.filter(([m]) => m === "usage.summary").at(-1)?.[1] as { since: number; until: number };
    expect(Math.round((last.until - last.since) / 86_400_000)).toBe(7);

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Read harness logs" }));
    });
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { glassBox: { readHarnessLogs: false } } });
    expect(rpc).toHaveBeenLastCalledWith("usage.summary", expect.objectContaining({ includeExternal: false }));
  });

  it("shows one section per connected environment", async () => {
    twoEnvironments();
    attachFakeStore(modelWith({}));
    const rpc = mockRoutedRpc({
      "usage.summary": (_p, opts) => summary({ pricingVersion: opts?.envId === "e1" ? "v1" : "v2" }),
    });
    render(<UsageView />);
    await screen.findByRole("region", { name: "Usage on Build box" });
    expect(screen.getByRole("region", { name: "Usage on Laptop" })).toBeDefined();
    expect(rpc).toHaveBeenCalledWith("usage.summary", expect.anything(), { envId: "e1" });
    expect(rpc).toHaveBeenCalledWith("usage.summary", expect.anything(), { envId: "e2" });
    expect(screen.getByText(/price table v2/)).toBeDefined();
  });

  it("lists each harness's limit windows with reset times", async () => {
    attachFakeStore(
      modelWith({
        threads: {
          t1: makeThread("t1", { rateLimit: { status: "warning", remainingPct: 8, note: "five_hour 92% used", resetsAt: Date.now() + 2 * 3_600_000, at: 2 } }),
          t2: makeThread("t2", { rateLimit: { status: "ok", remainingPct: 70, note: "seven_day 30% used", at: 3 } }),
        },
      }),
    );
    mockRpc({ "usage.summary": () => summary() });
    render(<UsageView />);
    await screen.findByRole("table");
    const limits = screen.getByRole("region", { name: "Limits" });
    expect(within(limits).getByText("92% used · resets in 2h")).toBeDefined();
    expect(within(limits).getByText("30% used")).toBeDefined();
    expect((within(limits).getByRole("meter", { name: "5h used" }) as HTMLMeterElement).value).toBe(92);
  });
});
