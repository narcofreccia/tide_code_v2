import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { TopBar } from "./TopBar.tsx";
import { chooseOption, resetUi, attachFakeStore, modelWith } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

const thread: Thread = {
  id: "t1",
  projectId: "p1",
  title: "Refactor router",
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
  resetUi();
  delete document.documentElement.dataset.desktop;
});

describe("TopBar", () => {
  it("renames the thread on Enter and switches provider", () => {
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<TopBar />);

    const title = screen.getByLabelText<HTMLInputElement>("Thread title");
    expect(title.value).toBe("Refactor router");
    fireEvent.change(title, { target: { value: "Router cleanup" } });
    fireEvent.blur(title);
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.update",
      threadId: "t1",
      title: "Router cleanup",
    });

    chooseOption("Provider", "codex");
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.update",
      threadId: "t1",
      provider: "codex",
    });
  });

  it("switches project through the listbox", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
      }),
    );
    render(<TopBar />);
    expect(screen.getByRole("combobox", { name: "Project switcher" }).textContent).toContain("All projects");
    chooseOption("Project switcher", /^Tide/);
    expect(useUi.getState().selectedProjectId).toBe("p1");
    expect(useUi.getState().view).toBe("mission");
  });

  it("is draggable and takes the traffic-light inset on the mac desktop shell", () => {
    document.documentElement.dataset.desktop = "mac";
    attachFakeStore(modelWith({}));
    render(<TopBar />);
    const bar = screen.getByRole("banner");
    // Tauri v2 drags from the attribute; `:root[data-desktop="mac"] .bar`
    // reserves the 78px inset, so the rule's target must stay the banner.
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(bar.className).toMatch(/bar/);
    expect(document.documentElement.matches('[data-desktop="mac"]')).toBe(true);
  });
});
