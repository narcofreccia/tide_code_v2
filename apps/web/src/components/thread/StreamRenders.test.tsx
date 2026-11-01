import { Profiler, memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { applyRecord, emptyReadModel, type DomainEvent, type ReadModel } from "@tide/contracts";
import { Stream } from "./Stream.tsx";
import { useModel } from "../../state/model.ts";
import { attachFakeStore, makeThread, resetUi } from "../../testHarness.ts";

/** MessageItem renders per message id (the spy keeps MessageItem's memo semantics) */
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("./MessageItem.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./MessageItem.tsx")>();
  const Spy = memo(function Spy(props: import("./MessageItem.tsx").MessageItemProps) {
    renders.set(props.message.id, (renders.get(props.message.id) ?? 0) + 1);
    return <real.MessageItem {...props} />;
  });
  return { ...real, MessageItem: Spy };
});

/** every text react-markdown parsed */
const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-markdown")>();
  const Counted = (props: Parameters<typeof real.default>[0]) => {
    parsed.push(String(props.children ?? ""));
    return real.default(props);
  };
  return { ...real, default: Counted };
});

let seq = 0;
let model: ReadModel = emptyReadModel();
let commits = 0;

function apply(event: DomainEvent): void {
  seq += 1;
  model = applyRecord(model, { seq, ts: seq, event });
}

/** Applies `event` to the store the way a streamed record lands. */
function land(event: DomainEvent): void {
  apply(event);
  const next = model;
  act(() => useModel.setState({ model: next }));
}

function settledTurn(threadId: string, n: number): void {
  const turnId = `${threadId}-t${n}`;
  apply({ type: "turn.requested", turn: { id: turnId, threadId, status: "requested", requestedAt: n * 10 }, userMessage: { id: `${turnId}-u`, threadId, turnId, role: "user", text: `prompt ${n}`, createdAt: n * 10 } });
  apply({ type: "turn.started", turnId, threadId, provider: "claude", startedAt: n * 10 + 1 });
  apply({ type: "activity.upserted", activity: { id: `${turnId}-tool`, threadId, turnId, kind: "tool", toolUseId: `${turnId}-tool`, toolName: "Bash", input: { command: "ls" }, status: "ok", createdAt: n * 10 + 2, updatedAt: n * 10 + 2 } });
  apply({ type: "assistant.delta", turnId, threadId, messageId: `${turnId}-a`, delta: `Reply **${n}**.\n\nSecond paragraph of ${n}.`, at: n * 10 + 3 });
  apply({ type: "turn.settled", turnId, threadId, status: "completed", settledAt: n * 10 + 4 });
}

function liveTurn(threadId: string): void {
  const turnId = `${threadId}-live`;
  apply({ type: "turn.requested", turn: { id: turnId, threadId, status: "requested", requestedAt: 1000 }, userMessage: { id: `${turnId}-u`, threadId, turnId, role: "user", text: "go on", createdAt: 1000 } });
  apply({ type: "turn.started", turnId, threadId, provider: "claude", startedAt: 1001 });
  apply({ type: "assistant.delta", turnId, threadId, messageId: `${turnId}-a`, delta: "Working on it.\n\nNow", at: 1002 });
}

function delta(threadId: string, text: string): DomainEvent {
  return { type: "assistant.delta", turnId: `${threadId}-live`, threadId, messageId: `${threadId}-live-a`, delta: text, at: 2000 + seq };
}

function reset(): void {
  renders.clear();
  parsed.length = 0;
  commits = 0;
}

beforeEach(() => {
  seq = 0;
  model = emptyReadModel();
  apply({ type: "project.created", project: { id: "p1", title: "P", rootPath: "/repo", createdAt: 1, updatedAt: 1 } });
  apply({ type: "thread.created", thread: makeThread("open", { title: "Open" }) });
  apply({ type: "thread.created", thread: makeThread("other", { title: "Other" }) });
  for (let n = 1; n <= 5; n++) settledTurn("open", n);
  settledTurn("other", 1);
  liveTurn("open");
  liveTurn("other");
  attachFakeStore(model);
  render(
    <Profiler id="stream" onRender={() => (commits += 1)}>
      <Stream threadId="open" provider="claude" />
    </Profiler>,
  );
  reset();
});

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Stream renders (R15)", () => {
  it("renders nothing for a delta on another thread", () => {
    for (let i = 0; i < 5; i++) land(delta("other", " word"));
    expect(commits).toBe(0);
    expect(renders.size).toBe(0);
    expect(parsed).toEqual([]);
  });

  it("re-renders only the streaming message for a delta on the open thread, re-parsing only its open block", () => {
    land(delta("open", " more"));
    expect(commits).toBe(1);
    expect([...renders.keys()]).toEqual(["open-live-a"]);
    expect(parsed).toEqual(["Now more"]);
  });

  it("does not re-parse settled messages when a new row lands on the open thread", () => {
    land({ type: "activity.upserted", activity: { id: "open-live-tool", threadId: "open", turnId: "open-live", kind: "tool", toolUseId: "open-live-tool", toolName: "Read", input: { file_path: "a.ts" }, status: "running", createdAt: 1003, updatedAt: 1003 } });
    expect(commits).toBe(1);
    expect(renders.size).toBe(0);
    expect(parsed).toEqual([]);
  });
});
