import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RailThreadRow, truncateRole } from "./RailThreadRow.tsx";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("rail team markers", () => {
  it("tags a delegate with its role, truncated, and marks the team lead", () => {
    const team = { name: "Ship", stages: [{ key: "a", role: "a", provider: "claude" as const, worktree: "own" as const }] };
    const lead = makeThread("lead", { team });
    const delegate = makeThread("d", { delegatedBy: "lead", delegateRole: "senior-security-reviewer" });
    attachFakeStore(modelWith({ threads: { lead, d: delegate } }));
    render(
      <ul>
        <RailThreadRow thread={delegate} siblings={[lead, delegate]} />
        <RailThreadRow thread={lead} siblings={[lead, delegate]} />
      </ul>,
    );
    expect(screen.getAllByText("senior-secu…").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("team").length).toBe(1);
    expect(truncateRole("short")).toBe("short");
  });
});

describe("rail delegate verdict tag", () => {
  const verdict = (label: string, confidence: number) => ({ site: "delegates" as const, label, confidence, source: "jev" as const, at: 1 });
  const row = (patch: Parameters<typeof makeThread>[1]) => {
    useServerSettings.setState({ settings: defaultUserSettings() });
    const lead = makeThread("lead");
    const d = makeThread("d", { delegatedBy: "lead", delegateRole: "worker", ...patch });
    attachFakeStore(modelWith({ threads: { lead, d } }));
    render(
      <ul>
        <RailThreadRow thread={d} siblings={[lead, d]} />
      </ul>,
    );
  };

  it("shows the label, painted as a problem for failed / blocked", () => {
    row({ judge: verdict("failed", 0.9) });
    const tag = screen.getByText("failed");
    expect(tag.getAttribute("title")).toBe("Judge: jev 0.90");
    expect(tag.className).toContain("badTag");
  });

  it("shows a good outcome neutrally and hides low-confidence or running verdicts", () => {
    row({ judge: verdict("done", 0.9) });
    expect(screen.getByText("done").className).not.toContain("badTag");
    cleanup();
    row({ judge: verdict("done", 0.3) });
    expect(screen.queryByText("done")).toBeNull();
    cleanup();
    row({ judge: verdict("done", 0.9), status: "running" });
    expect(screen.queryByText("done")).toBeNull();
  });
});
