import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { activeTab } from "../../state/workbench.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { SideChatsPopover, selectSideChats } from "./SideChatsList.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const threads = {
  t1: makeThread("t1"),
  s1: makeThread("s1", { title: "Side one", role: "side", parentThreadId: "t1", createdAt: 2 }),
  s2: makeThread("s2", { title: "Side two", role: "side", parentThreadId: "t1", createdAt: 3, archivedAt: 9 }),
  f1: makeThread("f1", { title: "A fork", parentThreadId: "t1" }),
};

describe("SideChatsPopover", () => {
  it("lists the live side chats only, and is stable while threads are", () => {
    const model = modelWith({ threads });
    expect(selectSideChats(model, "t1").map((t) => t.id)).toEqual(["s1"]);
    expect(selectSideChats(model, "t1")).toBe(selectSideChats(model, "t1"));
  });

  it("reopens a closed side chat's tab", () => {
    attachFakeStore(modelWith({ threads }));
    render(<SideChatsPopover threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: /1 side chat/ }));
    fireEvent.click(screen.getByRole("button", { name: /Side one/ }));
    expect(activeTab("t1")).toEqual({ kind: "side", threadId: "s1" });
  });

  it("renders nothing without side chats", () => {
    attachFakeStore(modelWith({ threads: { t1: threads.t1 } }));
    const { container } = render(<SideChatsPopover threadId="t1" />);
    expect(container.innerHTML).toBe("");
  });
});
