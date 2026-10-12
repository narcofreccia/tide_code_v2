import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectTotals } from "./ProjectTotals.tsx";
import { attachFakeStore, makeThread, makeTurn, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const today = Date.now();
const lastWeek = today - 8 * 24 * 3600 * 1000;

function fixture() {
  const model = modelWith({
    projects: {
      p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 },
      p2: { id: "p2", title: "Other", rootPath: "/src/other", createdAt: 1, updatedAt: 1 },
    },
    threads: {
      t1: makeThread("t1", {
        status: "running",
        updatedAt: today,
        totalCostUsd: 1.25,
        contextUsage: { used: 40, window: 100 },
      }),
      t2: makeThread("t2", {
        attention: "approval",
        updatedAt: today,
        totalCostUsd: 0.5,
        contextUsage: { used: 82, window: 100 },
      }),
      t3: makeThread("t3", { updatedAt: lastWeek, totalCostUsd: 9 }),
      t4: makeThread("t4", { updatedAt: today, totalCostUsd: 5, archivedAt: today }),
      t5: makeThread("t5", { projectId: "p2", updatedAt: today, totalCostUsd: 3 }),
    },
  });
  const turn = (id: string, threadId: string, costUsd: number, settledAt: number, provider?: "codex") =>
    makeTurn(id, { threadId, settledAt, usage: { inputTokens: 1, outputTokens: 1, costUsd }, ...(provider ? { provider } : {}) });
  for (const t of [
    turn("u1", "t1", 1.25, today),
    turn("u2", "t2", 0.5, today, "codex"),
    // t2 was touched today, but this turn settled last week: lifetime only
    turn("u3", "t2", 4, lastWeek),
    turn("u4", "t3", 9, lastWeek),
    // archived thread: still money spent
    turn("u5", "t4", 5, today),
    turn("u6", "t5", 3, today),
  ]) {
    model.turns[t.id] = t;
  }
  return model;
}

describe("project totals", () => {
  it("counts running / needs-you and sums today's cost, showing max context", () => {
    attachFakeStore(fixture());
    render(<ProjectTotals projectId="p1" />);
    const row = screen.getByLabelText("Project totals").textContent ?? "";
    expect(row).toContain("1 running");
    expect(row).toContain("1 needs you");
    expect(row).toContain("3 threads");
    expect(row).toContain("$6.75 today");
    expect(row).toContain("$19.75 lifetime");
    expect(row).toContain("max ctx 82%");
    expect(row).not.toContain("Other");
  });

  it("shows one strip per project when none is selected", () => {
    attachFakeStore(fixture());
    render(<ProjectTotals />);
    const strip = screen.getByLabelText("Project totals");
    const rows = strip.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    // projects are alphabetical: Other, then Tide
    expect(rows[0]?.textContent).toContain("Other");
    expect(rows[0]?.textContent).toContain("$3.00 today");
    expect(rows[1]?.textContent).toContain("$6.75 today");
  });

  it("splits cost by the provider that ran each turn, today's share on hover", () => {
    attachFakeStore(fixture());
    render(<ProjectTotals projectId="p1" />);
    const byProvider = screen.getByLabelText("Cost by provider");
    expect(byProvider.textContent).toBe("Claude Code $19.25Codex $0.50");
    const codex = screen.getByText("Codex $0.50");
    expect(codex.getAttribute("title")).toBe("Codex: $0.50 today · $0.50 lifetime");
  });

  it("aggregates every project in the header line", () => {
    attachFakeStore(fixture());
    render(<ProjectTotals aggregate />);
    const row = screen.getByLabelText("Project totals").textContent ?? "";
    expect(row).toContain("$9.75 today");
    expect(row).toContain("$22.75 lifetime");
  });
});
