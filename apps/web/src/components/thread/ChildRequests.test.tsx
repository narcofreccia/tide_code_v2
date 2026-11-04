import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Activity, ReadModel, Thread } from "@tide/contracts";
import { ChildRequests } from "./ChildRequests.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { useUi } from "../../state/ui.ts";
import { activeTab } from "../../state/workbench.ts";
import { attachFakeStore, makeApproval, makeThread, makeUserInput, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

/** A parent with a delegate and a side chat; activities land in their own thread's timeline. */
function model(activities: Activity[], extra: Thread[] = []): ReadModel {
  const parent = makeThread("t1", { title: "Parent" });
  const delegate = makeThread("d1", { title: "Fix the tests", delegatedBy: "t1", createdAt: 2 });
  const side = makeThread("s1", { title: "Side: Parent", role: "side", parentThreadId: "t1", createdAt: 3 });
  const m = modelWith({ threads: Object.fromEntries([parent, delegate, side, ...extra].map((t) => [t.id, t])) });
  for (const t of [parent, delegate, side, ...extra]) {
    m.threadMessages[t.id] = [];
    m.threadTimeline[t.id] = [];
  }
  for (const a of activities) {
    m.activities[a.id] = a;
    (m.threadTimeline[a.threadId] ??= []).push({ kind: "activity", id: a.id });
  }
  return m;
}

describe("ChildRequests", () => {
  it("renders nothing when no child waits", () => {
    attachFakeStore(model([]));
    const { container } = render(<ChildRequests threadId="t1" />);
    expect(container.innerHTML).toBe("");
  });

  it("answers a child's approval with the child's thread id", () => {
    const fake = attachFakeStore(model([makeApproval("a1", { threadId: "d1", requestId: "req-d" })]));
    render(<ChildRequests threadId="t1" />);
    expect(screen.getByText(/Approval needed from/).textContent).toContain("Fix the tests");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "approval.respond", threadId: "d1", requestId: "req-d", decision: "accept" });
  });

  it("takes no y / n hotkeys and shows no hint", () => {
    const fake = attachFakeStore(model([makeApproval("a1", { threadId: "d1" })]));
    render(<ChildRequests threadId="t1" />);
    fireEvent.keyDown(window, { key: "y" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(screen.queryByText("y")).toBeNull();
  });

  it("answers a child's question in place", () => {
    const fake = attachFakeStore(
      model([makeUserInput("q1", [{ id: "pick", text: "Which?", options: [{ label: "A" }, { label: "B" }] }], { threadId: "s1", requestId: "req-q" })]),
    );
    render(<ChildRequests threadId="t1" />);
    expect(screen.getByText(/Question from/).textContent).toContain("Side: Parent");
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "user-input.respond", threadId: "s1", requestId: "req-q", answers: { pick: "B" } });
  });

  it("Open selects the child thread", () => {
    attachFakeStore(model([makeApproval("a1", { threadId: "d1" })]));
    render(<ChildRequests threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Fix the tests" }));
    expect(useUi.getState().selectedThreadId).toBe("d1");
  });

  it("Open shows a side chat as its tab beside the parent", () => {
    attachFakeStore(model([makeApproval("a1", { threadId: "s1" })]));
    useUi.setState({ selectedThreadId: "t1", focusMode: "thread" });
    render(<ChildRequests threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Side: Parent" }));
    expect(useUi.getState().selectedThreadId).toBe("t1");
    expect(activeTab("t1")).toEqual({ kind: "side", threadId: "s1" });
    expect(useUi.getState().focusMode).toBe("split");
  });

  it("lists every waiting child, oldest first", () => {
    attachFakeStore(
      model([makeApproval("late", { threadId: "s1", createdAt: 9, toolName: "Bash" }), makeApproval("early", { threadId: "d1", createdAt: 5, toolName: "Write" })]),
    );
    render(<ChildRequests threadId="t1" />);
    const cards = within(screen.getByRole("region", { name: "Waiting in child threads" })).getAllByRole("region");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Approval: Write", "Approval: Bash"]);
  });

  it("does not repeat the parent's own pending card", () => {
    attachFakeStore(model([makeApproval("own", { threadId: "t1", toolName: "Edit" }), makeApproval("kid", { threadId: "d1", toolName: "Bash" })]));
    const parent = makeThread("t1", { title: "Parent" });
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<ThreadView thread={parent} />);
    expect(screen.getAllByRole("region", { name: "Approval: Edit" })).toHaveLength(1);
    const strip = screen.getByRole("region", { name: "Waiting in child threads" });
    expect(within(strip).queryByRole("region", { name: "Approval: Edit" })).toBeNull();
    expect(within(strip).getByRole("region", { name: "Approval: Bash" })).toBeTruthy();
  });
});
