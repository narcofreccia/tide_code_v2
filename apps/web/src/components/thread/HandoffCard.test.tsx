import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Handoff } from "@tide/contracts";
import { HandoffCard, handoffCoverage } from "./HandoffCard.tsx";

const handoff: Handoff = {
  id: "h1",
  threadId: "t1",
  sourceThreadId: "t1",
  fromProvider: "claude",
  toProvider: "codex",
  strategy: "full",
  coveredTurnIds: ["a", "b", "c"],
  omittedTurnIds: ["d"],
  text: "history",
  createdAt: 1,
};

afterEach(cleanup);

describe("HandoffCard", () => {
  it("reads the coverage of the recency selection", () => {
    expect(handoffCoverage(handoff)).toBe("covers 3 turns, 1 omitted");
  });

  it("reads the judge's summary once the handoff was refined", () => {
    const refined: Handoff = { ...handoff, judge: { kept: 9, dropped: 3, source: "jev", confidence: 0.8666, at: 2 } };
    render(<ul><HandoffCard handoff={refined} delivery="inline" /></ul>);
    expect(screen.getByText("12 items, 9 kept by judge (jev 0.87), 3 dropped")).toBeDefined();
  });
});
