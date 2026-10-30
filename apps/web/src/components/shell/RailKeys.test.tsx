import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { Rail } from "./Rail.tsx";
import { MergeConfirmHost } from "./MergeConfirmHost.tsx";
import { ToastHost } from "../ui/Toast.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";
import { clearRailSelection, useRailSelection } from "../../state/railSelection.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  clearRailSelection();
  useUi.setState({ mergeConfirmThreadId: null });
  useServerSettings.setState({ settings: defaultUserSettings() });
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function mount(threads: Thread[], confirmMergeBack = false) {
  const settings = defaultUserSettings();
  useServerSettings.setState({ settings: { ...settings, git: { ...settings.git, confirmMergeBack } } });
  const fake = attachFakeStore(modelWith({ projects: { p1: project }, threads: Object.fromEntries(threads.map((t) => [t.id, t])) }));
  render(
    <>
      <Rail />
      <MergeConfirmHost />
      <ToastHost />
    </>,
  );
  return fake;
}

const key = (k: string): void => {
  fireEvent.keyDown(document.activeElement ?? window, { key: k });
};
const focusedThread = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-rail-thread]")?.dataset.railThread;

const three = [
  makeThread("a", { title: "Alpha", updatedAt: 3, branch: "tide/alpha" }),
  makeThread("b", { title: "Bravo", updatedAt: 2 }),
  makeThread("c", { title: "Charlie", updatedAt: 1 }),
];

describe("rail keys", () => {
  it("j / k move focus down and up the visible rows; enter opens", () => {
    mount(three);
    key("j");
    expect(focusedThread()).toBe("a");
    key("j");
    key("j");
    key("j");
    expect(focusedThread()).toBe("c");
    key("k");
    expect(focusedThread()).toBe("b");
    key("Enter");
    expect(useUi.getState().selectedThreadId).toBe("b");
  });

  it("e settles the focused row, x toggles its selection", () => {
    const fake = mount(three);
    key("j");
    key("j");
    key("e");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.settle", threadId: "b" });
    key("x");
    expect(useRailSelection.getState().ids).toEqual(["b"]);
    key("Escape");
    expect(useRailSelection.getState().ids).toEqual([]);
  });

  it("s opens the snooze menu for the focused row", () => {
    mount(three);
    key("j");
    key("s");
    expect(screen.getByRole("menu", { name: "Snooze" })).toBeDefined();
  });

  it("m merges the focused branch back with no strategy (server defaults)", async () => {
    const fake = mount(three);
    key("j");
    await act(async () => key("m"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.merge", threadId: "a" });
    expect(screen.getByText("Merging “Alpha” back…")).toBeDefined();
    // a row without a branch: nothing to merge
    fake.dispatch.mockClear();
    key("j");
    await act(async () => key("m"));
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("m asks first when settings.git.confirmMergeBack is on", async () => {
    const fake = mount(three, true);
    key("j");
    await act(async () => key("m"));
    expect(fake.dispatch).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Merge back?" });
    expect(dialog.textContent).toContain("tide/alpha");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge back" }));
    });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.merge", threadId: "a" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("honours a rebound key", () => {
    mount(three);
    const settings = useServerSettings.getState().settings;
    useServerSettings.setState({ settings: { ...settings, keybindings: { "rail.next": "n" } } });
    key("j");
    expect(focusedThread()).toBeUndefined();
    key("n");
    expect(focusedThread()).toBe("a");
  });

  it("stays out of text fields", () => {
    const fake = mount(three);
    const input = screen.getByRole("searchbox", { name: "Search threads" });
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "e" });
    expect(document.activeElement).toBe(input);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });
});
