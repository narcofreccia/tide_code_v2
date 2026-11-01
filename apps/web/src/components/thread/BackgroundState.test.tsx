import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Activity, ActivityOf, ReadModel, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useChildReveal } from "../../state/childReveal.ts";
import { useUi } from "../../state/ui.ts";
import { attachFakeStore, makeMessage, makeThread, makeTool, makeTurn, mockRpc, modelWithTimeline, resetUi } from "../../testHarness.ts";
import { RailThreadRow } from "../shell/RailThreadRow.tsx";
import { StatusBar } from "../shell/StatusBar.tsx";
import { NowStrip } from "../mission/NowStrip.tsx";
import { isPassThrough } from "./HarnessEvents.tsx";
import { NoticeRow, reportedAgentName } from "./NoticeRow.tsx";
import { Stream } from "./Stream.tsx";
import { ThreadHeader } from "./ThreadHeader.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  useChildReveal.setState({ target: null });
});

function child(key: string, patch: Partial<ActivityOf<"child">> = {}): ActivityOf<"child"> {
  return { id: `c-${key}`, threadId: "t1", turnId: "u1", kind: "child", childKey: key, name: `Agent ${key}`, status: "running", createdAt: 10, updatedAt: 10, ...patch };
}

/** t1 idle after u1 (which launched `children`), with the reply m1 so the turn has a footer. */
function model(children: Activity[], thread: Thread = makeThread("t1", { latestTurnId: "u1" })): ReadModel {
  const m = modelWithTimeline(thread, children);
  m.turns.u1 = makeTurn("u1", { status: "completed", startedAt: 1, settledAt: 20 });
  m.messages.m1 = makeMessage("m1", { role: "assistant", text: "Launched the audit." });
  m.threadTimeline.t1 = [{ kind: "message", id: "m1" }, ...(m.threadTimeline.t1 ?? [])];
  return m;
}

describe("a thread whose sub-agents outlive the turn", () => {
  it("header pill reads Working · 1 agent in background, not Idle", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const m = model([child("a")]);
    attachFakeStore(m);
    const thread = m.threads.t1 as Thread;
    render(<ThreadHeader thread={thread} />);
    expect(screen.getByTitle("Working · 1 agent in background").getAttribute("data-state")).toBe("background");
    expect(screen.queryByTitle("Idle")).toBeNull();
  });

  it("header pill goes back to Idle when the agent reports", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const m = model([child("a", { status: "done" })]);
    attachFakeStore(m);
    render(<ThreadHeader thread={m.threads.t1 as Thread} />);
    expect(screen.getByTitle("Idle")).toBeDefined();
  });

  it("the header title shimmers while sub-agents work and stops when they report", () => {
    mockRpc({ "thread.terminalCommand": () => ({}) });
    const working = model([child("a")]);
    attachFakeStore(working);
    render(<ThreadHeader thread={working.threads.t1 as Thread} />);
    expect(screen.getByTitle("Rename").querySelector("[data-live-label]")?.textContent).toBe((working.threads.t1 as Thread).title);
    cleanup();
    const done = model([child("a", { status: "done" })]);
    attachFakeStore(done);
    render(<ThreadHeader thread={done.threads.t1 as Thread} />);
    expect(screen.getByTitle("Rename").querySelector("[data-live-label]")).toBeNull();
  });

  it("status bar says thread: 1 agent in background", () => {
    attachFakeStore(model([child("a")]));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<StatusBar />);
    expect(screen.getByText(/thread:/).textContent).toBe("thread: 1 agent in background");
  });

  it("rail row shows a background live line with its own glyph and tooltip", () => {
    const m = model([child("a"), child("b", { createdAt: 11, updatedAt: 11 })]);
    attachFakeStore(m);
    const { container } = render(
      <ul>
        <RailThreadRow thread={m.threads.t1 as Thread} siblings={[m.threads.t1 as Thread]} />
      </ul>,
    );
    const line = container.querySelector("[data-live-kind]") as HTMLElement;
    expect(line.getAttribute("data-live-kind")).toBe("background");
    expect(line.getAttribute("title")).toBe("2 sub-agents working in the background");
    expect(line.textContent).toContain("2 agents in background");
    expect(screen.getByRole("img", { name: "Working · 2 agents in background" }).textContent).toBe("◉");
  });

  it("Mission Control's Now strip lists it without a Stop button", () => {
    attachFakeStore(model([child("a")]));
    render(<NowStrip />);
    const now = screen.getByRole("region", { name: "Now" });
    expect(within(now).getByText("1 agent in background")).toBeDefined();
    expect(within(now).queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("the turn's conclusion updates when the background agent settles later", () => {
    const m = model([child("a")]);
    attachFakeStore(m);
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByTestId("turn-conclusion").textContent).toBe("ended · 1 sub-agent with no result yet · the thread continues when they report");
    act(() => useModel.setState({ model: { ...m, activities: { ...m.activities, "c-a": child("a", { status: "done", updatedAt: 40 }) } } }));
    expect(screen.getByTestId("turn-conclusion").textContent).toBe("ended · 1 sub-agent finished");
  });

  it("a later turn's conclusion does not read as all done while an earlier agent works", () => {
    const m = model([child("a")], makeThread("t1", { latestTurnId: "u2" }));
    m.turns.u2 = makeTurn("u2", { status: "completed", requestedAt: 30, settledAt: 40 });
    m.messages.m2 = makeMessage("m2", { turnId: "u2", role: "assistant", text: "Something else.", createdAt: 35 });
    m.threadTimeline.t1 = [...(m.threadTimeline.t1 ?? []), { kind: "message", id: "m2" }];
    attachFakeStore(m);
    render(<Stream threadId="t1" provider="claude" />);
    const [first, second] = screen.getAllByTestId("turn-conclusion");
    expect(first?.textContent).not.toContain("earlier turn");
    expect(second?.textContent).toBe("ended · 1 sub-agent from an earlier turn still working");
  });

  it("tool rows of a background agent keep their live mark after the turn settled", () => {
    const m = model([child("a", { status: "running" }), makeTool("x1", { parentToolUseId: "a", status: "running", toolName: "Bash", input: { command: "pnpm test" } })]);
    attachFakeStore(m);
    const { container } = render(<Stream threadId="t1" provider="claude" />);
    // the settled turn closes the group; open it
    fireEvent.click(screen.getByRole("button", { name: /subagent: Agent a/ }));
    const row = screen.getByRole("button", { name: "Bash pnpm test" });
    expect(row.querySelector("[data-live-label]")).not.toBeNull();
    expect(container.querySelector("[data-child-key='a']")).not.toBeNull();
  });
});

describe("the harness-initiated turn", () => {
  it("parses the driver's reported summary and leaves others alone", () => {
    expect(reportedAgentName('sub-agent "Design workspace" reported')).toBe("Design workspace");
    expect(reportedAgentName("sub-agent 'Audit' reported")).toBe("Audit");
    expect(reportedAgentName("Claude Code continued on its own")).toBeUndefined();
  });

  it("links the reporting agent to its group in the transcript", () => {
    const m = model([child("a", { name: "Design workspace", status: "done", report: "All done." })]);
    const notice = makeMessage("n1", { turnId: "u2", createdAt: 50, notification: { source: "harness", summary: 'sub-agent "Design workspace" reported' } });
    m.messages.n1 = notice;
    attachFakeStore(m);
    const { container } = render(
      <ol>
        <NoticeRow message={notice} provider="claude" />
      </ol>,
    );
    expect(container.textContent).toContain("Design workspace reported");
    expect(container.textContent).toContain("Claude continued");
    fireEvent.click(screen.getByRole("button", { name: "Design workspace" }));
    expect(useChildReveal.getState().target).toMatchObject({ threadId: "t1", childKey: "a" });
  });

  it("keeps an unknown summary as pass-through", () => {
    const notice = makeMessage("n1", { notification: { source: "harness", summary: "Claude Code continued on its own" } });
    attachFakeStore(model([]));
    const { container } = render(
      <ol>
        <NoticeRow message={notice} provider="claude" />
      </ol>,
    );
    expect(screen.getByText("Claude continued")).toBeDefined();
    expect(screen.getByText("Claude Code continued on its own")).toBeDefined();
    expect(container.querySelector("button")).toBeNull();
  });

  it("folds rate-limit warning rows (the limit badge shows them) but keeps a rejection visible", () => {
    const info = (text: string): Activity => ({ id: text, threadId: "t1", turnId: "u1", kind: "info", text, createdAt: 1, updatedAt: 1 });
    expect(isPassThrough(info("Rate limit allowed_warning on seven_day_overage_included (96% used)"))).toBe(true);
    expect(isPassThrough(info("Rate limit rejected on five_hour (100% used)"))).toBe(false);
  });
});
