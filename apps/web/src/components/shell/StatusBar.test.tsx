import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("StatusBar", () => {
  it("reports the thread only while the thread is what the view shows", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { worktreePath: "/w/t1", branch: "tide/t1" }) } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<StatusBar />);
    expect(screen.getByText(/thread:/)).toBeDefined();
    act(() => useUi.setState({ view: "mission" }));
    expect(screen.queryByText(/thread:/)).toBeNull();
    expect(screen.queryByText(/tide\/t1/)).toBeNull();
    act(() => useUi.setState({ view: "settings" }));
    expect(screen.queryByText(/thread:/)).toBeNull();
  });

  it("shows the tightest harness limit per window and hides it when the setting is off", () => {
    attachFakeStore(
      modelWith({
        threads: {
          t1: makeThread("t1", { rateLimit: { status: "ok", remainingPct: 38, note: "five_hour 62% used", at: 10 } }),
          t2: makeThread("t2", { rateLimit: { status: "ok", remainingPct: 82, note: "seven_day 18% used", at: 11 } }),
          t3: makeThread("t3", {
            provider: "codex",
            rateLimit: { status: "ok", remainingPct: 90, note: "codex 10% used (5h window)", at: 12 },
          }),
        },
      }),
    );
    render(<StatusBar />);
    const item = screen.getByRole("button", { name: "Claude 5h 62% · wk 18%" });
    act(() => item.click());
    expect(useUi.getState().view).toBe("usage");

    act(() =>
      useServerSettings.setState((s) => ({
        settings: { ...s.settings, glassBox: { ...s.settings.glassBox, limitsInStatusBar: false } },
      })),
    );
    expect(screen.queryByText(/5h 62%/)).toBeNull();
  });

  it("formats thread cost with formatUsd", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { totalCostUsd: 0.004 }) } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<StatusBar />);
    expect(screen.getByText("<$0.01")).toBeDefined();
  });
});
