import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Message, ReadModel, Thread } from "@tide/contracts";
import { COMPOSE_EVENT } from "../../lib/cite.ts";
import { useUi } from "../../state/ui.ts";
import { openSideTab, threadTabs } from "../../state/workbench.ts";
import { attachFakeStore, makeApproval, makeMessage, makeThread, makeTurn, modelWith, resetUi } from "../../testHarness.ts";
import { SidePane } from "./SidePane.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const parent = makeThread("t1", { title: "Parent" });
const side = makeThread("s1", { title: "Side: Parent", role: "side", parentThreadId: "t1" });

function model(sidePatch: Partial<Thread> = {}, answered = true): ReadModel {
  const m = modelWith({ threads: { t1: parent, s1: { ...side, ...sidePatch } } });
  m.threadMessages["s1"] = [];
  m.threadTimeline["s1"] = [];
  if (!answered) return m;
  m.turns["u9"] = makeTurn("u9", { threadId: "s1", status: "completed" });
  const messages: Message[] = [makeMessage("m1", { threadId: "s1", turnId: "u9", role: "user", text: "q" }), makeMessage("m2", { threadId: "s1", turnId: "u9", role: "assistant", text: "the answer" })];
  for (const msg of messages) m.messages[msg.id] = msg;
  m.threadMessages["s1"] = messages.map((msg) => msg.id);
  m.threadTimeline["s1"] = messages.map((msg) => ({ kind: "message" as const, id: msg.id }));
  return m;
}

describe("SidePane", () => {
  it("shows the side chat's title, stream and its own composer", () => {
    const fake = attachFakeStore(model());
    render(<SidePane parentId="t1" sideId="s1" />);
    expect(screen.getByRole("region", { name: "Side chat Side: Parent" })).toBeTruthy();
    expect(screen.getByText("the answer")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "and Y?" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", threadId: "s1", text: "and Y?" }));
  });

  it("Bring back quotes the answer into the parent's composer", () => {
    attachFakeStore(model());
    const seen = vi.fn();
    const listener = (e: Event): void => seen((e as CustomEvent<unknown>).detail);
    window.addEventListener(COMPOSE_EVENT, listener);
    render(<SidePane parentId="t1" sideId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /Bring back/ }));
    window.removeEventListener(COMPOSE_EVENT, listener);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ mode: "append", threadId: "t1" }));
  });

  it("Bring back is off before the first answer and while running", () => {
    attachFakeStore(model({ status: "running" }));
    render(<SidePane parentId="t1" sideId="s1" />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Bring back/ }).disabled).toBe(true);
  });

  it("Close deletes an unused side chat and drops its tab", () => {
    const fake = attachFakeStore(model({}, false));
    openSideTab("t1", "s1");
    render(<SidePane parentId="t1" sideId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close side chat" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.delete", threadId: "s1" });
    expect(threadTabs("t1").some((t) => t.kind === "side")).toBe(false);
  });

  it("Delete asks first when the side chat has a conversation", () => {
    const fake = attachFakeStore(model());
    render(<SidePane parentId="t1" sideId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(useUi.getState().threadDialog).toEqual({ kind: "delete", threadId: "s1" });
  });

  it("its approvals take no y / n", () => {
    const m = model({}, false);
    const approval = makeApproval("a1", { threadId: "s1" });
    m.activities["a1"] = approval;
    m.threadTimeline["s1"] = [{ kind: "activity", id: "a1" }];
    const fake = attachFakeStore(m);
    render(<SidePane parentId="t1" sideId="s1" />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "y" });
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("says so when the side chat is gone", () => {
    attachFakeStore(modelWith({ threads: { t1: parent } }));
    render(<SidePane parentId="t1" sideId="s1" />);
    expect(screen.getByText("This side chat is gone.")).toBeTruthy();
  });
});
