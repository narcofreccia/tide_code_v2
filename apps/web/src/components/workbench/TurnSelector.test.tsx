import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ALL_CHANGES } from "../../state/vcs.ts";
import { makeMessage, makeThread, makeTurn, modelWithTurns } from "../../testHarness.ts";
import { TurnSelector } from "./TurnSelector.tsx";

const LONG = "Refactor the router so that every provider shares the same normalizer";

const model = modelWithTurns(
  makeThread("t1"),
  [
    makeTurn("u1", { checkpoint: { before: "a", after: "b", stats: { files: 2, additions: 120, deletions: 14 } } }),
    makeTurn("u2", { requestedAt: 2, checkpoint: { before: "b", after: "c" } }),
    makeTurn("u3", { requestedAt: 3 }),
  ],
  [makeMessage("m1", { turnId: "u1", text: LONG }), makeMessage("m2", { turnId: "u2", text: "fix tests" })],
);

const turns = [model.turns.u1!, model.turns.u2!];

afterEach(cleanup);

describe("TurnSelector", () => {
  it("lists only turns with a checkpoint, labelled by prompt, plus All changes", () => {
    render(<TurnSelector model={model} threadId="t1" turns={turns} selection="u2" onSelect={() => {}} />);

    expect(screen.getByText("Turn 2 of 2")).toBeDefined();
    fireEvent.click(screen.getByText("Turn 2 of 2"));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByText(`${LONG.slice(0, 40)}…`)).toBeDefined();
    expect(screen.getByText("fix tests")).toBeDefined();
    expect(screen.getByText("+120")).toBeDefined();
    expect(screen.getByText("−14")).toBeDefined();
    expect(screen.getByText("All changes")).toBeDefined();
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("reports the picked turn and All changes", () => {
    const onSelect = vi.fn();
    render(<TurnSelector model={model} threadId="t1" turns={turns} selection="u2" onSelect={onSelect} />);

    fireEvent.click(screen.getByText("Turn 2 of 2"));
    fireEvent.click(screen.getByText("All changes"));
    expect(onSelect).toHaveBeenCalledWith(ALL_CHANGES);
  });
});

describe("TurnSelector commits", () => {
  const commits = [
    { sha: "a1b2c3d4e5f6", shortSha: "a1b2c3d", subject: "feat: add thing", author: "A", at: Date.now() - 3 * 3600_000, parents: ["p1"] },
    { sha: "0f0f0f0f", shortSha: "0f0f0f0", subject: "init", author: "A", at: Date.now() - 3 * 86400_000, parents: [] },
  ];

  it("switches to Commits and reports the commit: selection", () => {
    const onSelect = vi.fn();
    render(<TurnSelector model={model} threadId="t1" turns={turns} selection="u2" onSelect={onSelect} commits={commits} />);
    fireEvent.click(screen.getByText("Turn 2 of 2"));
    fireEvent.click(screen.getByLabelText("Commits"));
    expect(screen.getByText("feat: add thing")).toBeDefined();
    expect(screen.getByText("a1b2c3d")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
    expect(screen.queryByText("All changes")).toBeNull();
    fireEvent.click(screen.getByText("feat: add thing"));
    expect(onSelect).toHaveBeenCalledWith("commit:a1b2c3d4e5f6");
  });

  it("labels a commit selection and opens on the Commits source", () => {
    render(<TurnSelector model={model} threadId="t1" turns={turns} selection="commit:a1b2c3d4e5f6" onSelect={() => {}} commits={commits} />);
    fireEvent.click(screen.getByText("Commit a1b2c3d"));
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("has no segment without a commit list", () => {
    render(<TurnSelector model={model} threadId="t1" turns={turns} selection="u2" onSelect={() => {}} />);
    fireEvent.click(screen.getByText("Turn 2 of 2"));
    expect(screen.queryByLabelText("Commits")).toBeNull();
  });
});
