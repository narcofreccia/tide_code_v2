import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { ProjectTree } from "./ProjectTree.tsx";
import { RailSelectionBar } from "./RailSelectionBar.tsx";
import { useInboxKeys } from "./useInboxKeys.ts";
import { ToastHost } from "../ui/Toast.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { resetSettleUndo } from "../../lib/inboxActions.ts";
import { clearRailSelection, useRailSelection } from "../../state/railSelection.ts";
import { resetLastSeen } from "../../state/lastSeen.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";

beforeEach(() => resetLastSeen(Number.MAX_SAFE_INTEGER));

afterEach(() => {
  cleanup();
  resetUi();
  resetSettleUndo();
  clearRailSelection();
  useServerSettings.setState({ settings: defaultUserSettings() });
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function Keys() {
  useInboxKeys();
  return null;
}

function mount(threads: Thread[]) {
  const model = modelWith({ projects: { p1: project }, threads: Object.fromEntries(threads.map((t) => [t.id, t])) });
  for (const t of threads) model.threadMessages[t.id] = ["m1"];
  const fake = attachFakeStore(model);
  render(
    <nav aria-label="Navigation">
      <Keys />
      <RailSelectionBar />
      <ProjectTree />
      <ToastHost />
    </nav>,
  );
  return fake;
}

const flush = (): Promise<void> => act(async () => undefined);

describe("settle from the rail", () => {
  it("settles from the row's box and offers Undo in the toast", async () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    fireEvent.click(screen.getByRole("button", { name: "Settle Router" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.settle", threadId: "t1" });
    await flush();
    expect(screen.getByText("Settled “Router”")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.unsettle", threadId: "t1" });
  });

  it("⌘Z unsettles the newest settle, but not while a text field has focus", async () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    fireEvent.click(screen.getByRole("button", { name: "Settle Router" }));
    await flush();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { key: "z", metaKey: true });
    expect(fake.dispatch).not.toHaveBeenCalledWith({ type: "thread.unsettle", threadId: "t1" });
    input.remove();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.unsettle", threadId: "t1" });
    // nothing left to undo
    fake.dispatch.mockClear();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("lists settled threads under a collapsed Settled group with the reason tag", () => {
    const fake = mount([
      makeThread("t1", { title: "Open one" }),
      makeThread("t2", { title: "Merged one", settledAt: 5, settleReason: "pr-merged" }),
      makeThread("t3", { title: "Old one", settledAt: 4, settleReason: "inactive" }),
    ]);
    expect(screen.queryByText("Merged one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Settled · 2/ }));
    const list = screen.getByRole("list", { name: "Settled threads" });
    expect(within(list).getByText("merged")).toBeDefined();
    expect(within(list).getByText("inactive")).toBeDefined();
    fireEvent.click(within(list).getByRole("button", { name: "Unsettle Merged one" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unsettle", threadId: "t2" });
  });

  it("collects running threads under Working only when the setting is on", () => {
    const threads = [makeThread("t1", { title: "Busy", status: "running" }), makeThread("t2", { title: "Calm" })];
    mount(threads);
    expect(screen.queryByRole("button", { name: /Working · / })).toBeNull();
    cleanup();
    useServerSettings.setState({
      settings: { ...defaultUserSettings(), inbox: { ...defaultUserSettings().inbox, workingSection: true } },
    });
    mount(threads);
    expect(screen.queryByText("Busy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Working · 1/ }));
    expect(within(screen.getByRole("list", { name: "Working threads" })).getByText("Busy")).toBeDefined();
  });

  it("the rail menu toggles auto-settle for the thread", () => {
    const fake = mount([makeThread("t1", { title: "Router" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Router" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Auto-settle this thread/ }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", autoSettle: false });
  });
});

describe("rail multi-select", () => {
  const three = [
    makeThread("a", { title: "Alpha", updatedAt: 3 }),
    makeThread("b", { title: "Bravo", updatedAt: 2 }),
    makeThread("c", { title: "Charlie", updatedAt: 1 }),
  ];

  it("⌘-click toggles, shift-click extends a range, Esc clears", () => {
    mount(three);
    fireEvent.click(screen.getByText("Alpha"), { metaKey: true });
    expect(screen.getByText("1 selected")).toBeDefined();
    fireEvent.click(screen.getByText("Charlie"), { shiftKey: true });
    expect(useRailSelection.getState().ids.sort()).toEqual(["a", "b", "c"]);
    fireEvent.click(screen.getByText("Bravo"), { metaKey: true });
    expect(screen.getByText("2 selected")).toBeDefined();
    // a selection click does not open the thread
    expect(useUi.getState().selectedThreadId).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();
  });

  it("settles the whole selection with one Undo", async () => {
    const fake = mount(three);
    fireEvent.click(screen.getByText("Alpha"), { metaKey: true });
    fireEvent.click(screen.getByText("Bravo"), { metaKey: true });
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Settle" }));
    await flush();
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.settle", threadId: "a" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.settle", threadId: "b" });
    expect(screen.getByText("Settled 2 threads")).toBeDefined();
    expect(useRailSelection.getState().ids).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unsettle", threadId: "a" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unsettle", threadId: "b" });
  });

  it("snoozes the selection for an hour", async () => {
    const fake = mount(three);
    fireEvent.click(screen.getByText("Charlie"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Snooze ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "1 hour" }));
    await flush();
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.snooze", threadId: "c", until: expect.any(Number) }),
    );
  });

  it("regenerates titles one by one and reports failures", async () => {
    mount(three);
    const order: string[] = [];
    const rpc = mockRpc({
      "thread.regenerateTitle": ((p: { threadId: string }) => {
        order.push(p.threadId);
        if (p.threadId === "b") throw new Error("no harness can answer");
        return { title: `New ${p.threadId}`, provider: "claude" };
      }) as never,
    });
    fireEvent.click(screen.getByText("Alpha"), { metaKey: true });
    fireEvent.click(screen.getByText("Bravo"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate titles" }));
    await waitFor(() => expect(screen.getByText(/Regenerated 1 title, 1 failed — Bravo: no harness can answer/)).toBeDefined());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("unread dot", () => {
  it("shows for activity since the last look, not on the open thread", () => {
    resetLastSeen(0);
    const model = modelWith({
      projects: { p1: project },
      threads: { t1: makeThread("t1", { title: "Quiet", updatedAt: 9 }), t2: makeThread("t2", { title: "Open", updatedAt: 9 }) },
    });
    model.threadMessages.t1 = ["m1", "m2"];
    model.threadMessages.t2 = ["m3"];
    attachFakeStore(model);
    useUi.setState({ view: "thread", selectedThreadId: "t2" });
    render(<ProjectTree />);
    expect(screen.getAllByRole("img", { name: "unread" })).toHaveLength(1);
    expect(within(screen.getByText("Quiet").closest("li") as HTMLElement).getByRole("img", { name: "unread" })).toBeDefined();
  });
});
