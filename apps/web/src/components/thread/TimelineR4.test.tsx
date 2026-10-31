import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Handoff } from "@tide/contracts";
import { Stream } from "./Stream.tsx";
import { attachFakeStore, makeMessage, makeThread, makeTurn, modelWithTurns, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const thread = makeThread("t1");

describe("Stream R4 rows", () => {
  it("tags a steer message", () => {
    attachFakeStore(modelWithTurns(thread, [makeTurn("u1")], [makeMessage("m1", { text: "go left", steer: true })]));
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("steer")).toBeDefined();
    expect(screen.getByText("go left")).toBeDefined();
  });

  it("renders a notification as a notice row, not a user bubble", () => {
    attachFakeStore(
      modelWithTurns(thread, [makeTurn("u1")], [
        makeMessage("m1", { text: "raw wake-up text", notification: { source: "pr", summary: "CI failed on #7" } }),
      ]),
    );
    const { container } = render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("CI failed on #7")).toBeDefined();
    expect(screen.queryByText("raw wake-up text")).toBeNull();
    expect(container.querySelector('[data-source="pr"]')).not.toBeNull();
  });

  it("renders a harness-initiated turn as a labelled notice, not a user bubble", () => {
    attachFakeStore(
      modelWithTurns(thread, [makeTurn("u1")], [
        makeMessage("m1", { text: "raw", notification: { source: "harness", summary: 'sub-agent "Audit" reported' } }),
      ]),
    );
    const { container } = render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("Claude continued")).toBeDefined();
    expect(screen.getByText('sub-agent "Audit" reported')).toBeDefined();
    expect(screen.queryByText("raw")).toBeNull();
    expect(container.querySelector('[data-source="harness"]')).not.toBeNull();
  });

  it("shows a collapsed handoff card above the user message", () => {
    const handoff: Handoff = {
      id: "h1",
      threadId: "t1",
      sourceThreadId: "t1",
      fromProvider: "claude",
      toProvider: "codex",
      strategy: "full",
      coveredTurnIds: ["a", "b", "c"],
      omittedTurnIds: ["d"],
      text: "verbatim history",
      createdAt: 1,
    };
    const model = modelWithTurns(thread, [makeTurn("u1", { handoffId: "h1", handoffDelivery: "inline" })], [
      makeMessage("m1", { text: "continue" }),
    ]);
    model.handoffs = { h1: handoff };
    attachFakeStore(model);
    render(<Stream threadId="t1" provider="codex" />);
    expect(screen.getByText("covers 3 turns, 1 omitted")).toBeDefined();
    expect(screen.getByText("inline")).toBeDefined();
    expect(screen.queryByText("verbatim history")).toBeNull();
    fireEvent.click(screen.getByText("Handoff"));
    expect(screen.getByText("verbatim history")).toBeDefined();
  });

  it("dims rolled-back turns and tags them", () => {
    attachFakeStore(modelWithTurns(thread, [makeTurn("u1", { rolledBack: true })], [makeMessage("m1", { text: "old" })]));
    const { container } = render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("rolled back")).toBeDefined();
    expect(container.querySelector('[data-rolled-back="true"]')).not.toBeNull();
  });
});
