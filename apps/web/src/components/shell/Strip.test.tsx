import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Strip } from "./Strip.tsx";
import { attachFakeStore, makeApproval, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { resetPrs } from "../prs/prData.ts";
import { makePr } from "../prs/testFixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetPrs();
});

const PROJECT = { id: "p1", title: "App", rootPath: "/src/app", createdAt: 1, updatedAt: 1 };

describe("Strip", () => {
  it("marks the active page with aria-current and names its shortcut in the tooltip", () => {
    attachFakeStore(modelWith({ projects: { p1: PROJECT } }));
    render(<Strip />);
    const mission = screen.getByRole("button", { name: "Mission Control" });
    expect(mission.getAttribute("aria-current")).toBe("page");
    expect(mission.getAttribute("title")).toBe("Mission Control (⌘0)");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("title")).toBe("Settings (⌘,)");

    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(useUi.getState().view).toBe("usage");
    expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Mission Control" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUi.getState().view).toBe("settings");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });

  it("badges Inbox with the threads that need you and Pull requests with the open count", () => {
    const model = modelWith({
      projects: { p1: PROJECT },
      threads: {
        t1: makeThread("t1", { attention: "approval" }),
        t2: makeThread("t2", { pr: makePr(3) }),
        t3: makeThread("t3", { pr: makePr(4, { state: "merged" }) }),
      },
    });
    // two cards on one thread still count it once
    model.activities["a1"] = makeApproval("a1", { threadId: "t1" });
    model.activities["a2"] = makeApproval("a2", { threadId: "t1" });
    model.threadTimeline["t1"] = [{ kind: "activity", id: "a1" }, { kind: "activity", id: "a2" }];
    attachFakeStore(model);
    render(<Strip />);
    const inbox = screen.getByRole("button", { name: "Inbox · 1 need you" });
    expect(inbox.textContent).toBe("1");
    expect(screen.getByRole("button", { name: "Pull requests · 1 open" }).textContent).toBe("1");
  });

  it("Inbox toggles the rail and reports it as pressed", () => {
    attachFakeStore(modelWith({}));
    render(<Strip />);
    const inbox = screen.getByRole("button", { name: "Inbox" });
    expect(inbox.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(inbox);
    expect(useUi.getState().railCollapsed).toBe(true);
    expect(inbox.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows no environments button with a single server", () => {
    attachFakeStore(modelWith({}));
    render(<Strip />);
    expect(screen.queryByRole("button", { name: /Environments/ })).toBeNull();
  });
});
