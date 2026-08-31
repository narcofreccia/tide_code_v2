import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Board } from "./Board.tsx";
import { ExpertsView } from "./ExpertsView.tsx";
import {
  attachFakeStore,
  makeExpertsMessage,
  makeExpertsSession,
  makeFinding,
  makePlan,
  makeThread,
  modelWithExperts,
  resetUi,
} from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { threadTabs } from "../../state/workbench.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const session = makeExpertsSession("x1");

describe("Experts board", () => {
  it("renders the expert cards, findings and discussion from the model", () => {
    attachFakeStore(
      modelWithExperts(
        session,
        [makeFinding("f1", { text: "the seam is the index writer" })],
        [
          makeExpertsMessage("m1", { from: "security", to: "architect", text: "what signs the shard map?" }),
          makeExpertsMessage("m2", { from: "user", to: "all", text: "keep it revertible" }),
        ],
      ),
    );
    render(<Board sessionId="x1" />);

    expect(screen.getByLabelText("Expert Architect")).toBeDefined();
    expect(screen.getByLabelText("Expert Security")).toBeDefined();
    const findings = within(screen.getByLabelText("Findings"));
    expect(findings.getByText("the seam is the index writer")).toBeDefined();
    expect(findings.getByText("Architect")).toBeDefined();
    const discussion = within(screen.getByLabelText("Discussion"));
    expect(discussion.getByText("what signs the shard map?")).toBeDefined();
    // the user's own post is attributed to them and highlighted
    expect(discussion.getByText("You")).toBeDefined();
    expect(discussion.getByText("keep it revertible").closest("li")?.className).toMatch(/mine/);
  });

  it("posts to the panel with the chosen recipient", () => {
    const fake = attachFakeStore(modelWithExperts(session));
    render(<Board sessionId="x1" />);

    fireEvent.change(screen.getByLabelText("Post to the panel"), { target: { value: "  focus on writes  " } });
    fireEvent.change(screen.getByLabelText("Post to"), { target: { value: "security" } });
    fireEvent.click(screen.getByText("Post"));

    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "experts.post",
      sessionId: "x1",
      text: "focus on writes",
      to: "security",
    });
  });

  it("omits `to` when the post goes to everyone", () => {
    const fake = attachFakeStore(modelWithExperts(session));
    render(<Board sessionId="x1" />);
    fireEvent.change(screen.getByLabelText("Post to the panel"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Post"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "experts.post", sessionId: "x1", text: "hello" });
  });

  it("advances the phase and jumps straight to a phase from the stepper", () => {
    const fake = attachFakeStore(modelWithExperts(session));
    render(<Board sessionId="x1" />);

    fireEvent.click(screen.getByText("Next phase"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "experts.set-phase",
      sessionId: "x1",
      phase: "discussing",
    });

    fireEvent.click(screen.getByText("Synthesizing"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "experts.set-phase",
      sessionId: "x1",
      phase: "synthesizing",
    });
  });

  it("archives the session and leaves the board", () => {
    const fake = attachFakeStore(modelWithExperts(session));
    useUi.getState().selectExpertsSession("x1");
    render(<Board sessionId="x1" />);
    fireEvent.click(screen.getByText("Archive"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "experts.archive", sessionId: "x1" });
    expect(useUi.getState().selectedExpertsSessionId).toBeNull();
  });

  it("renders the synthesis with the linked plan card", () => {
    const model = modelWithExperts(
      makeExpertsSession("x1", {
        phase: "ready",
        synthesis: { markdown: "Ship the writer split", planId: "pl1", at: 9 },
      }),
    );
    model.plans.pl1 = makePlan("pl1", { markdown: "## Plan\n\n1. split the writer" });
    attachFakeStore(model);
    render(<Board sessionId="x1" />);

    const synthesis = within(screen.getByLabelText("Synthesis"));
    expect(synthesis.getByText("Ship the writer split")).toBeDefined();
    expect(screen.getByLabelText("Proposed plan")).toBeDefined();
    expect(screen.getByText("Implement in new thread ▾")).toBeDefined();
  });

  it("opens an expert's thread beside the board and keeps the board as a workbench tab", () => {
    const bound = makeExpertsSession("x1", {
      experts: [
        { key: "architect", name: "Architect", role: "system design", provider: "claude", status: "working", threadId: "t9" },
      ],
    });
    attachFakeStore(
      modelWithExperts(bound, [], [], [makeThread("t9", { role: "expert", expertsSessionId: "x1" })]),
    );
    render(<Board sessionId="x1" />);

    fireEvent.click(screen.getByLabelText("Expert Architect"));
    expect(useUi.getState().selectedThreadId).toBe("t9");
    expect(useUi.getState().view).toBe("thread");
    expect(threadTabs("t9").map((t) => t.kind)).toEqual(["changes", "experts"]);
  });

  it("returns to the previous view on Esc", () => {
    attachFakeStore(modelWithExperts(session));
    useUi.getState().selectExpertsSession("x1");
    render(<ExpertsView sessionId="x1" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().view).toBe("mission");
  });
});
