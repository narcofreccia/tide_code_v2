import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyRecord, type ReadModel } from "@tide/contracts";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { resetDrafts } from "../../state/drafts.ts";
import { useModel } from "../../state/model.ts";

/*
 * Render-count spies on the composer's memoized children: each module's real component
 * is kept (memo wrapper and comparator included) and only its inner render is counted.
 * If the memo is dropped, the plain function is wrapped and every keystroke counts.
 */
const renders = vi.hoisted(() => ({ QueueList: 0, ThreadPills: 0 }));

type Render = (props: object) => ReactNode;
type Memoish = Render | { type: Render };

function spy(name: keyof typeof renders, real: Memoish): Memoish {
  const count = (inner: Render): Render => (props) => {
    renders[name] += 1;
    return inner(props);
  };
  return typeof real === "function" ? count(real) : { ...real, type: count(real.type) };
}

vi.mock("./QueueList.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./QueueList.tsx")>();
  return { ...actual, QueueList: spy("QueueList", actual.QueueList as unknown as Memoish) };
});
vi.mock("./ThreadPills.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ThreadPills.tsx")>();
  return { ...actual, ThreadPills: spy("ThreadPills", actual.ThreadPills as unknown as Memoish) };
});

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
});

function runningWithQueue(): { model: ReadModel; thread: ReturnType<typeof makeThread> } {
  const thread = makeThread("t1", { status: "running" });
  let model = modelWith({ threads: [thread] });
  let seq = model.seq;
  const record = (event: Parameters<typeof applyRecord>[1]["event"]): void => {
    seq += 1;
    model = applyRecord(model, { seq, ts: seq, event });
  };
  record({
    type: "turn.requested",
    turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 1 },
    userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "first", createdAt: 1 },
  });
  record({ type: "turn.started", turnId: "u1", threadId: "t1", provider: "claude", startedAt: 2 });
  record({
    type: "turn.requested",
    turn: { id: "u2", threadId: "t1", status: "queued", requestedAt: 3 },
    userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "queued one", createdAt: 3 },
  });
  return { model, thread: model.threads["t1"] ?? thread };
}

describe("Composer render isolation", () => {
  it("typing 20 characters re-renders neither the queue nor the pills", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const { model, thread } = runningWithQueue();
    attachFakeStore(model);
    render(<Composer thread={thread} />);
    expect(screen.getByText("queued one")).toBeDefined();
    renders.QueueList = 0;
    renders.ThreadPills = 0;

    const input = screen.getByLabelText("Message");
    const typed = "abcdefghijklmnopqrst";
    for (let i = 1; i <= typed.length; i++) fireEvent.change(input, { target: { value: typed.slice(0, i) } });

    expect((input as HTMLTextAreaElement).value).toBe(typed);
    expect(renders.QueueList).toBe(0);
    expect(renders.ThreadPills).toBe(0);
  });

  it("a streaming delta does not re-render the queue", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const { model, thread } = runningWithQueue();
    attachFakeStore(model);
    render(<Composer thread={thread} />);
    renders.QueueList = 0;
    for (let i = 0; i < 5; i++) {
      const current = useModel.getState().model;
      const next = applyRecord(current, {
        seq: current.seq + 1,
        ts: 10 + i,
        event: { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "a1", delta: "word ", at: 10 + i },
      });
      act(() => useModel.setState({ model: next }));
    }
    expect(renders.QueueList).toBe(0);
  });
});
