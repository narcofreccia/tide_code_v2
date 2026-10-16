import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RailThreadRow, truncateRole } from "./RailThreadRow.tsx";
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
