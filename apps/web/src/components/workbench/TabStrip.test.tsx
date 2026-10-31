import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resetUi } from "../../testHarness.ts";
import { editDoc, useDocs } from "../../state/docs.ts";
import { activeTab, openFileTab, setActiveTab, tabKey, threadTabs, useActiveTab, useThreadTabs } from "../../state/workbench.ts";
import { TabStrip } from "./TabStrip.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

function Harness({ running = false }: { running?: boolean }) {
  const tabs = useThreadTabs("t1");
  const current = tabs.find((t) => tabKey(t) === tabKey(activeTab("t1"))) ?? tabs[0]!;
  return <TabStrip threadId="t1" tabs={tabs} active={current} running={running} />;
}

describe("TabStrip", () => {
  it("shows Changes first and the open files after it", () => {
    openFileTab("t1", "src/a.ts");
    render(<Harness />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs[0]).toBe("Changes");
    expect(tabs[1]).toContain("a.ts");
  });

  it("marks a dirty file with a dot", () => {
    openFileTab("t1", "src/a.ts");
    useDocs.setState({ docs: { "t1:src/a.ts": { loading: false, content: "x", saved: "x" } } });
    const view = render(<Harness />);
    expect(view.container.querySelector('[aria-label="unsaved changes"]')).toBeNull();
    act(() => editDoc("t1", "src/a.ts", "changed"));
    expect(view.container.querySelector('[aria-label="unsaved changes"]')).not.toBeNull();
  });

  it("closes a file tab with the × and with a middle click", () => {
    openFileTab("t1", "src/a.ts");
    openFileTab("t1", "src/b.ts");
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Close a.ts"));
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }, { kind: "file", path: "src/b.ts" }]);
    const wrap = screen.getByTitle("src/b.ts").parentElement!;
    fireEvent(wrap, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(threadTabs("t1")).toEqual([{ kind: "changes" }]);
  });

  it("hints that the agent is writing in the worktree", () => {
    render(<Harness running />);
    expect(screen.getByText("agent running")).toBeTruthy();
  });

  describe("overflow", () => {
    function size(el: HTMLElement, scrollWidth: number, clientWidth: number) {
      Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
      Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
    }

    it("scrolls the tabs in a hidden-scrollbar region, apart from the actions", () => {
      render(
        <TabStrip threadId="t1" tabs={[{ kind: "changes" }]} active={{ kind: "changes" }} running={false}>
          <button type="button">Files</button>
        </TabStrip>,
      );
      const list = screen.getByRole("tablist");
      expect(list.classList.contains("scrollX")).toBe(true);
      expect(list.contains(screen.getByText("Files"))).toBe(false);
    });

    it("reports which ends hide tabs in data-overflow", () => {
      render(<Harness />);
      const list = screen.getByRole("tablist");
      expect(list.dataset.overflow).toBe("none");
      size(list, 600, 200);
      fireEvent.scroll(list);
      expect(list.dataset.overflow).toBe("end");
      list.scrollLeft = 200;
      fireEvent.scroll(list);
      expect(list.dataset.overflow).toBe("both");
      list.scrollLeft = 400;
      fireEvent.scroll(list);
      expect(list.dataset.overflow).toBe("start");
    });

    it("turns a vertical wheel into horizontal scroll when the tabs overflow", () => {
      render(<Harness />);
      const list = screen.getByRole("tablist");
      fireEvent.wheel(list, { deltaY: 80 });
      expect(list.scrollLeft).toBe(0);
      size(list, 600, 200);
      const notCancelled = fireEvent.wheel(list, { deltaY: 80 });
      expect(list.scrollLeft).toBe(80);
      expect(notCancelled).toBe(false);
      fireEvent.wheel(list, { deltaX: 30, deltaY: 5 });
      expect(list.scrollLeft).toBe(80);
    });

    it("scrolls the active tab into view when it changes", () => {
      const spy = vi.fn();
      const original = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = spy;
      try {
        openFileTab("t1", "src/a.ts");
        openFileTab("t1", "src/b.ts");
        function Live() {
          return <TabStrip threadId="t1" tabs={useThreadTabs("t1")} active={useActiveTab("t1")} running={false} />;
        }
        render(<Live />);
        spy.mockClear();
        act(() => setActiveTab("t1", { kind: "file", path: "src/a.ts" }));
        expect(spy).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" });
        expect(spy.mock.contexts.at(-1)).toBe(screen.getByTitle("src/a.ts"));
      } finally {
        HTMLElement.prototype.scrollIntoView = original;
      }
    });
  });
});
