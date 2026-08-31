import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectTotals } from "./ProjectTotals.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const today = Date.now();
const lastWeek = today - 8 * 24 * 3600 * 1000;

function fixture() {
  return modelWith({
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
}

describe("project totals", () => {
  it("counts running / needs-you and sums today's cost, showing max context", () => {
    attachFakeStore(fixture());
    render(<ProjectTotals projectId="p1" />);
    const row = screen.getByLabelText("Project totals").textContent ?? "";
    expect(row).toContain("1 running");
    expect(row).toContain("1 needs you");
    expect(row).toContain("3 threads");
    expect(row).toContain("$1.75 today");
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
    expect(rows[1]?.textContent).toContain("$1.75 today");
  });
});
