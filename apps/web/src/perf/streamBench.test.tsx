import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyRecord, emptyReadModel, type DomainEvent, type EventRecord, type ReadModel } from "@tide/contracts";
import { ThreadView } from "../components/thread/ThreadView.tsx";
import { RailGroups } from "../components/shell/RailGroups.tsx";
import { PROVIDER_FIXTURE } from "../components/settings/fixtures.ts";
import { setProvidersForTest } from "../state/providers.ts";
import { useModel } from "../state/model.ts";
import { attachFakeStore, makeThread, resetUi } from "../testHarness.ts";

/*
 * Render benchmark for the thread stream and the rail (R15). Not a correctness test: it
 * builds a long thread through the real projector, then applies streaming deltas on the
 * open thread and on another thread and reports commits and render time per delta.
 * Run it alone: `cd apps/web && TIDE_PERF=1 npx vitest run src/perf` — the numbers print
 * to the console. Thresholds are loose on purpose; the printed numbers are the point.
 */

const PERF = process.env["TIDE_PERF"] === "1";

const PARAGRAPH =
  "The build runs the gates in order: typecheck, unit tests, then the bundle. A failing gate stops the run and the row says which one. " +
  "Use `pnpm test` for the fast loop and read the journal before touching the decider.\n\n";

function records(events: DomainEvent[]): EventRecord[] {
  return events.map((event, i) => ({ seq: i + 1, ts: 1_700_000_000_000 + i, event }));
}

/** Builds `turns` settled turns on `threadId`: user prompt, tool rows, a long assistant reply. */
function longThreadEvents(threadId: string, turns: number, toolsPerTurn: number, paragraphs: number): DomainEvent[] {
  const out: DomainEvent[] = [];
  let at = 1_700_000_000_000;
  for (let n = 0; n < turns; n++) {
    const turnId = `${threadId}-turn-${n}`;
    const userId = `${turnId}-user`;
    out.push({
      type: "turn.requested",
      turn: { id: turnId, threadId, status: "requested", requestedAt: at },
      userMessage: { id: userId, threadId, turnId, role: "user", text: `Step ${n}: ${PARAGRAPH.slice(0, 80)}`, createdAt: at },
    });
    out.push({ type: "turn.started", turnId, threadId, provider: "claude", startedAt: at + 1 });
    for (let k = 0; k < toolsPerTurn; k++) {
      const id = `${turnId}-tool-${k}`;
      out.push({
        type: "activity.upserted",
        activity: { id, threadId, turnId, kind: "tool", toolUseId: id, toolName: k % 2 ? "Read" : "Bash", input: { command: `ls -la src/${k}` }, status: "ok", output: "ok\n".repeat(20), createdAt: at + 2 + k, updatedAt: at + 3 + k },
      });
    }
    const messageId = `${turnId}-assistant`;
    for (let p = 0; p < paragraphs; p++) out.push({ type: "assistant.delta", turnId, threadId, messageId, delta: PARAGRAPH, at: at + 100 + p });
    out.push({ type: "turn.settled", turnId, threadId, status: "completed", settledAt: at + 200 });
    at += 1000;
  }
  return out;
}

function buildModel(): ReadModel {
  let model = emptyReadModel();
  const base: DomainEvent[] = [
    { type: "project.created", project: { id: "p1", title: "Perf", rootPath: "/repo", createdAt: 1, updatedAt: 1 } },
    { type: "thread.created", thread: makeThread("open", { title: "Long open thread" }) },
    { type: "thread.created", thread: makeThread("other", { title: "Another running thread" }) },
    ...Array.from({ length: 10 }, (_, i): DomainEvent => ({ type: "thread.created", thread: makeThread(`t${i}`, { title: `Thread ${i}` }) })),
  ];
  const events = [...base, ...longThreadEvents("open", 40, 6, 6), ...longThreadEvents("other", 10, 4, 3)];
  // one open turn on each thread so deltas land on a live message
  for (const threadId of ["open", "other"]) {
    const turnId = `${threadId}-live`;
    events.push({
      type: "turn.requested",
      turn: { id: turnId, threadId, status: "requested", requestedAt: 1_800_000_000_000 },
      userMessage: { id: `${turnId}-user`, threadId, turnId, role: "user", text: "go on", createdAt: 1_800_000_000_000 },
    });
    events.push({ type: "turn.started", turnId, threadId, provider: "claude", startedAt: 1_800_000_000_001 });
  }
  for (const record of records(events)) model = applyRecord(model, record);
  return model;
}

interface Counter {
  commits: number;
  ms: number;
}

function onRender(counter: Counter): ProfilerOnRenderCallback {
  return (_id, _phase, actualDuration) => {
    counter.commits += 1;
    counter.ms += actualDuration;
  };
}

afterEach(() => {
  cleanup();
  resetUi();
});

describe("stream render benchmark", () => {
  it(PERF ? "measures renders per streaming delta" : "runs the benchmark shape (set TIDE_PERF=1 for numbers)", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const start = buildModel();
    const fake = attachFakeStore(start);
    const thread = start.threads["open"]!;
    const stream: Counter = { commits: 0, ms: 0 };
    const rail: Counter = { commits: 0, ms: 0 };
    const t0 = performance.now();
    render(
      <>
        <Profiler id="rail" onRender={onRender(rail)}>
          <RailGroups projectIds={["p1"]} showProject={false} />
        </Profiler>
        <Profiler id="stream" onRender={onRender(stream)}>
          <ThreadView thread={thread} />
        </Profiler>
      </>,
    );
    const mountMs = performance.now() - t0;
    const mountCommits = { stream: stream.commits, rail: rail.commits };

    const run = (threadId: string, count: number): { streamCommits: number; streamMs: number; railCommits: number; railMs: number; wallMs: number } => {
      const before = { s: stream.commits, sm: stream.ms, r: rail.commits, rm: rail.ms };
      let model = useModel.getState().model;
      let seq = model.seq;
      const turnId = `${threadId}-live`;
      const w0 = performance.now();
      for (let i = 0; i < count; i++) {
        seq += 1;
        model = applyRecord(model, { seq, ts: 1_800_000_000_100 + i, event: { type: "assistant.delta", turnId, threadId, messageId: `${turnId}-assistant`, delta: i % 7 === 0 ? "\n\nNext: " : "word ", at: 1_800_000_000_100 + i } });
        const next = model;
        act(() => useModel.setState({ model: next }));
      }
      return {
        streamCommits: stream.commits - before.s,
        streamMs: stream.ms - before.sm,
        railCommits: rail.commits - before.r,
        railMs: rail.ms - before.rm,
        wallMs: performance.now() - w0,
      };
    };

    const N = PERF ? 100 : 5;
    const onOpen = run("open", N);
    const onOther = run("other", N);
    fake.detach();

    const summary = {
      mountMs: Math.round(mountMs),
      mountCommits,
      timelineEntries: start.threadTimeline["open"]?.length ?? 0,
      perDeltaOnOpenThread: { streamCommits: onOpen.streamCommits / N, streamMs: +(onOpen.streamMs / N).toFixed(2), railCommits: onOpen.railCommits / N, railMs: +(onOpen.railMs / N).toFixed(2), wallMs: +(onOpen.wallMs / N).toFixed(2) },
      perDeltaOnOtherThread: { streamCommits: onOther.streamCommits / N, streamMs: +(onOther.streamMs / N).toFixed(2), railCommits: onOther.railCommits / N, railMs: +(onOther.railMs / N).toFixed(2), wallMs: +(onOther.wallMs / N).toFixed(2) },
    };
    if (PERF) console.log(`\nSTREAM BENCH ${JSON.stringify(summary, null, 2)}\n`);
    expect(summary.timelineEntries).toBeGreaterThan(300);
  }, 120_000);
});
