import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { applyRecord, emptyReadModel, type DomainEvent, type ReadModel } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { attachFakeStore, makeThread, resetUi } from "../../testHarness.ts";
import { RailGroups } from "./RailGroups.tsx";
import { buildRailGroups } from "./railGroupModel.ts";

// R15: what a streaming delta costs the rail. ThreadGlyph renders once per row render: it is the row spy.
const renders = vi.hoisted(() => [] as string[]);

vi.mock("../ui/StatusGlyph.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/StatusGlyph.tsx")>();
  return {
    ...actual,
    ThreadGlyph: (props: Parameters<typeof actual.ThreadGlyph>[0]) => {
      renders.push(props.thread.id);
      return actual.ThreadGlyph(props);
    },
  };
});

vi.mock("./railGroupModel.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./railGroupModel.ts")>();
  return { ...actual, buildRailGroups: vi.fn(actual.buildRailGroups) };
});

afterEach(() => {
  cleanup();
  resetUi();
});

let seq = 0;
function apply(model: ReadModel, event: DomainEvent): ReadModel {
  seq += 1;
  return applyRecord(model, { seq, ts: 1_000 + seq, event });
}

/** p1 with two running threads (a, b), a delegate of a (d), and an idle thread (c). */
function setup(): void {
  seq = 0;
  let model = emptyReadModel();
  const events: DomainEvent[] = [
    { type: "project.created", project: { id: "p1", title: "P", rootPath: "/p", createdAt: 1, updatedAt: 1 } },
    { type: "thread.created", thread: makeThread("a", { updatedAt: 4 }) },
    { type: "thread.created", thread: makeThread("b", { updatedAt: 3 }) },
    { type: "thread.created", thread: makeThread("c", { updatedAt: 2 }) },
    { type: "thread.created", thread: makeThread("d", { updatedAt: 1, delegatedBy: "a", role: "delegate" }) },
  ];
  for (const threadId of ["a", "b"]) {
    events.push({
      type: "turn.requested",
      turn: { id: `${threadId}-t`, threadId, status: "requested", requestedAt: 10 },
      userMessage: { id: `${threadId}-u`, threadId, turnId: `${threadId}-t`, role: "user", text: "go", createdAt: 10 },
    });
    events.push({ type: "turn.started", turnId: `${threadId}-t`, threadId, provider: "claude", startedAt: 11 });
  }
  for (const e of events) model = apply(model, e);
  attachFakeStore(model);
  render(<RailGroups projectIds={["p1"]} showProject={false} />);
}

function step(event: DomainEvent): void {
  const next = apply(useModel.getState().model, event);
  act(() => useModel.setState({ model: next }));
}

const delta = (threadId: string, text: string): DomainEvent => ({
  type: "assistant.delta",
  threadId,
  turnId: `${threadId}-t`,
  messageId: `${threadId}-m`,
  delta: text,
  at: 20 + seq,
});

describe("rail renders under streaming", () => {
  it("a message delta re-renders only the running row, and later deltas render nothing", () => {
    setup();
    expect(renders).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));
    renders.length = 0;
    // the first delta creates the message: a's row goes Thinking → Writing
    step(delta("a", "Hello"));
    expect(renders).toEqual(["a"]);
    renders.length = 0;
    for (let i = 0; i < 5; i++) step(delta("a", " more"));
    step(delta("b", "Hi"));
    expect(renders).toEqual(["b"]);
    renders.length = 0;
    step(delta("b", " there"));
    expect(renders).toEqual([]);
  });

  it("rebuilds the groups only when threads change, not on an unrelated activity update", () => {
    setup();
    const build = vi.mocked(buildRailGroups);
    const calls = build.mock.calls.length;
    step({
      type: "activity.upserted",
      activity: { id: "x1", threadId: "b", turnId: "b-t", kind: "tool", toolUseId: "x1", toolName: "Read", input: { file_path: "/p/a.ts" }, status: "ok", createdAt: 30, updatedAt: 30 },
    });
    step(delta("a", "text"));
    expect(build.mock.calls.length).toBe(calls);
    renders.length = 0;
    // a rename replaces the threads map: one rebuild, and only the renamed row draws again
    step({ type: "thread.updated", threadId: "c", patch: { title: "Renamed" }, updatedAt: 40 });
    expect(build.mock.calls.length).toBe(calls + 1);
    expect(renders).toEqual(["c"]);
  });
});
