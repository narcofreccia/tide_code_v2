import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Stream } from "./Stream.tsx";
import {
  attachFakeStore,
  makeApproval,
  makeThread,
  makeMessage,
  makeTool,
  makeTurn,
  modelWithTimeline,
  modelWithTurns,
  resetUi,
} from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const thread = makeThread("t1");

describe("Stream", () => {
  it("renders a single activity row with its tool and target", () => {
    attachFakeStore(modelWithTimeline(thread, [makeTool("a1", { toolName: "Bash", input: { command: "pnpm test" }, durationMs: 2100 })]));
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("pnpm test")).toBeDefined();
    expect(screen.getByText("2.1s")).toBeDefined();
  });

  it("collapses consecutive reads into a group that expands", () => {
    attachFakeStore(
      modelWithTimeline(thread, [makeTool("a1"), makeTool("a2"), makeTool("a3"), makeTool("a4")]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("read 4 files")).toBeDefined();
    expect(screen.queryByText("Read")).toBeNull();

    fireEvent.click(screen.getByText("read 4 files"));
    expect(screen.getAllByText("Read")).toHaveLength(4);
  });

  it("expands a row to show input and output", () => {
    attachFakeStore(
      modelWithTimeline(thread, [makeTool("a1", { toolName: "Bash", input: { command: "ls" }, output: "a.ts" })]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.queryByText("output")).toBeNull();
    fireEvent.click(screen.getByLabelText("Bash ls"));
    expect(screen.getByText("output")).toBeDefined();
    expect(screen.getByText("a.ts")).toBeDefined();
  });

  it("renders a queued turn after the turn it waited behind, keeping its queued tag", () => {
    const first = makeTurn("u1", { status: "completed", requestedAt: 1, startedAt: 1, settledAt: 10 });
    const queued = makeTurn("u2", { status: "completed", requestedAt: 5, startedAt: 10, settledAt: 12 });
    const model = modelWithTurns(thread, [first, queued], [
      makeMessage("p1", { text: "run sleep" }),
      makeMessage("p2", { turnId: "u2", text: "reply QUEUED" }),
      makeMessage("r1", { role: "assistant", text: "THREE" }),
      makeMessage("r2", { role: "assistant", turnId: "u2", text: "QUEUED" }),
    ]);
    // log order: the queued prompt landed while u1 was still working
    const bash = makeTool("bash", { toolName: "Bash", input: { command: "sleep 5" } });
    model.activities[bash.id] = bash;
    model.threadTimeline[thread.id] = [
      { kind: "message", id: "p1" },
      { kind: "message", id: "p2" },
      { kind: "activity", id: "bash" },
      { kind: "message", id: "r1" },
      { kind: "message", id: "r2" },
    ];
    attachFakeStore(model);
    render(<Stream threadId="t1" provider="claude" />);
    const order = [...document.querySelectorAll("li")]
      .map((li) => li.textContent ?? "")
      .filter((text) => /run sleep|reply QUEUED|sleep 5|^THREE/.test(text));
    expect(order.map((t) => (t.includes("reply QUEUED") ? "p2" : t.includes("run sleep") ? "p1" : t.includes("sleep 5") ? "bash" : "r1"))).toEqual(["p1", "bash", "r1", "p2"]);
    const prompt = screen.getByText("reply QUEUED").closest("li");
    expect(prompt?.textContent).toContain("queued");
    expect(screen.getByText("run sleep").closest("li")?.textContent).not.toContain("queued");
  });

  it("marks only the last pending approval as the live prompt", () => {
    attachFakeStore(
      modelWithTimeline(thread, [
        makeApproval("a1", { status: "resolved", decision: "accept" }),
        makeApproval("a2"),
      ]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("Allowed Edit")).toBeDefined();
    expect(screen.getAllByText("Allow")).toHaveLength(1);
  });

  it("puts the turn footer under the last assistant message of a settled turn", () => {
    const turn = makeTurn("u1", {
      status: "completed",
      startedAt: 0,
      settledAt: 2000,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    attachFakeStore(
      modelWithTurns(thread, [turn], [
        makeMessage("m1", { role: "assistant", text: "first" }),
        makeMessage("m2", { role: "assistant", text: "second" }),
      ]),
    );
    render(<Stream threadId="t1" provider="claude" />);

    expect(screen.getAllByText("2.0s")).toHaveLength(1);
    const footer = screen.getByText("2.0s").closest("li");
    expect(footer?.textContent).toContain("second");
  });
});
