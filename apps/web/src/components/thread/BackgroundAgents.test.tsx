import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ActivityOf, ReadModel } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useChildReveal } from "../../state/childReveal.ts";
import { attachFakeStore, makeMessage, makeThread, makeTool, makeTurn, modelWithTimeline, resetUi } from "../../testHarness.ts";
import { BackgroundAgents, lastText, shortDuration } from "./BackgroundAgents.tsx";
import { Stream } from "./Stream.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  useChildReveal.setState({ target: null });
});

const MIN = 60_000;

function child(key: string, patch: Partial<ActivityOf<"child">> = {}): ActivityOf<"child"> {
  return { id: `c-${key}`, threadId: "t1", turnId: "u1", kind: "child", childKey: key, name: `Agent ${key}`, description: "Explore", status: "running", createdAt: 1_000, updatedAt: 1_000, ...patch };
}

/** t1 idle after turn u1, which launched the given children (and their tool rows). */
function idleModel(entries: Parameters<typeof modelWithTimeline>[1]): ReadModel {
  const model = modelWithTimeline(makeThread("t1", { latestTurnId: "u1" }), entries);
  model.turns.u1 = makeTurn("u1", { status: "completed", settledAt: 900 });
  return model;
}

function setModel(model: ReadModel): void {
  act(() => useModel.setState({ model }));
}

describe("BackgroundAgents strip", () => {
  it("lists a running background agent with its last tool call, count and elapsed time", () => {
    attachFakeStore(
      idleModel([
        child("a"),
        makeTool("x1", { parentToolUseId: "a", input: { command: "ls" }, createdAt: 1_500, updatedAt: 1_500 }),
        makeTool("x2", { parentToolUseId: "a", input: { file_path: "/r/skills.py" }, createdAt: 2_000, updatedAt: 2_000 }),
      ]),
    );
    render(<BackgroundAgents threadId="t1" now={10_000} />);
    const strip = screen.getByRole("region", { name: "Background agents" });
    expect(strip.textContent).toContain("Agent a");
    expect(strip.textContent).toContain("Explore");
    expect(strip.textContent).toContain("last: Read skills.py · 8s ago");
    expect(strip.textContent).toContain("2 tools");
    expect(screen.getByLabelText("running for 0:09")).toBeDefined();
  });

  it("ticks with the injected clock and turns quiet past five minutes", () => {
    attachFakeStore(idleModel([child("a")]));
    const { rerender } = render(<BackgroundAgents threadId="t1" now={4_000} />);
    expect(screen.getByText("started 3s ago")).toBeDefined();
    rerender(<BackgroundAgents threadId="t1" now={1_000 + 12 * MIN} />);
    expect(screen.getByText("quiet for 12m")).toBeDefined();
    expect(screen.getByRole("button", { name: /Agent a/ }).hasAttribute("data-quiet")).toBe(true);
    expect(screen.getByLabelText("running for 12:00")).toBeDefined();
  });

  it("folds more than three agents into one summary line that expands", () => {
    attachFakeStore(idleModel(["a", "b", "c", "d"].map((k, i) => child(k, { createdAt: 1_000 + i, updatedAt: 1_000 + i }))));
    render(<BackgroundAgents threadId="t1" now={5_000} />);
    const summary = screen.getByRole("button", { name: /4 agents in background/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Agent a/ })).toBeNull();
    fireEvent.click(summary);
    expect(screen.getAllByRole("button", { name: /^Agent / })).toHaveLength(4);
  });

  it("disappears once its agents finish", () => {
    const model = idleModel([child("a")]);
    attachFakeStore(model);
    render(<BackgroundAgents threadId="t1" now={5_000} />);
    expect(screen.getByRole("region", { name: "Background agents" })).toBeDefined();
    setModel({ ...model, activities: { ...model.activities, "c-a": child("a", { status: "done", updatedAt: 4_000 }) } });
    expect(screen.queryByRole("region", { name: "Background agents" })).toBeNull();
  });

  it("is absent while nothing runs in the background", () => {
    attachFakeStore(idleModel([child("a", { status: "done" })]));
    const { container } = render(<BackgroundAgents threadId="t1" now={5_000} />);
    expect(container.innerHTML).toBe("");
  });

  it("a click opens and scrolls to the agent's group in the transcript", () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const model = idleModel([child("a"), makeTool("x1", { parentToolUseId: "a", status: "ok", toolName: "Grep", input: { pattern: "needle" } })]);
      model.messages.m1 = makeMessage("m1", { role: "assistant", text: "launched it" });
      model.threadTimeline.t1 = [{ kind: "message", id: "m1" }, ...(model.threadTimeline.t1 ?? [])];
      attachFakeStore(model);
      render(
        <>
          <Stream threadId="t1" provider="claude" />
          <BackgroundAgents threadId="t1" now={5_000} />
        </>,
      );
      // the turn settled: the group starts closed
      expect(screen.queryByRole("button", { name: "Grep needle" })).toBeNull();
      const strip = screen.getByRole("region", { name: "Background agents" });
      fireEvent.click(within(strip).getByRole("button", { name: /Agent a/ }));
      expect(useChildReveal.getState().target).toMatchObject({ threadId: "t1", childKey: "a" });
      expect(screen.getByRole("button", { name: "Grep needle" })).toBeDefined();
      expect(scroll).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("strip text", () => {
  it("formats short durations", () => {
    expect(shortDuration(8_000)).toBe("8s");
    expect(shortDuration(12 * MIN)).toBe("12m");
    expect(shortDuration(65 * MIN)).toBe("1h 5m");
    expect(shortDuration(120 * MIN)).toBe("2h");
  });

  it("prefers silence over a stale last step", () => {
    const base = { activityId: "c", childKey: "c", threadId: "t", turnId: "u", name: "n", startedAt: 0, lastActivityAt: 0, toolCalls: 1 };
    expect(lastText({ ...base, last: { toolName: "Bash", target: "pnpm test", at: 0 }, quietMs: 3_000 })).toBe("last: Bash pnpm test · 3s ago");
    expect(lastText({ ...base, last: { toolName: "Bash", at: 0 }, quietMs: 6 * MIN })).toBe("quiet for 6m");
  });
});
