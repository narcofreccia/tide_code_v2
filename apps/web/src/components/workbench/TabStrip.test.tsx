import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resetUi } from "../../testHarness.ts";
import { editDoc, useDocs } from "../../state/docs.ts";
import { activeTab, openFileTab, tabKey, threadTabs, useThreadTabs } from "../../state/workbench.ts";
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
});
