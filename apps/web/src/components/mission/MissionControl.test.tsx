import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReadModel } from "@tide/contracts";
import { MissionControl } from "./MissionControl.tsx";
import { Rail } from "../shell/Rail.tsx";
import {
  attachFakeStore,
  makeApproval,
  makePlan,
  makeThread,
  modelWith,
  resetUi,
} from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

/** Two idle threads, one waiting on an approval and one on a plan. */
function fixture(): ReadModel {
  const model = modelWith({
    projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
    threads: {
      t1: makeThread("t1", { title: "Quiet thread", updatedAt: 500 }),
      t2: makeThread("t2", { title: "Waiting on approval", attention: "approval", updatedAt: 100 }),
      t3: makeThread("t3", { title: "Plan ready", attention: "plan", updatedAt: 200 }),
    },
  });
  model.activities["a1"] = makeApproval("a1", { threadId: "t2" });
  model.plans["pl1"] = makePlan("pl1", { threadId: "t3" });
  model.threadTimeline["t1"] = [];
  model.threadTimeline["t2"] = [{ kind: "activity", id: "a1" }];
  model.threadTimeline["t3"] = [{ kind: "plan", id: "pl1" }];
  return model;
}

describe("Mission Control", () => {
  it("lists what each needs-you thread is waiting on, newest first", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const inbox = screen.getByLabelText("Inbox");
    expect(inbox.textContent).toContain("Plan ready");
    expect(inbox.textContent).toContain("Approval: Edit /repo/src/x.ts");
    expect(screen.getAllByText("jump →")).toHaveLength(2);
  });

  it("sorts needs-you threads above the quiet ones", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    const titles = screen
      .getAllByText(/Quiet thread|Waiting on approval|Plan ready/)
      .map((n) => n.textContent);
    // inbox rows come first, then the thread list
    expect(titles.slice(-3)).toEqual(["Plan ready", "Waiting on approval", "Quiet thread"]);
  });

  it("jumps to the thread from an inbox row", () => {
    attachFakeStore(fixture());
    render(<MissionControl />);
    fireEvent.click(screen.getAllByText("jump →")[0] as HTMLElement);
    expect(useUi.getState().selectedThreadId).toBe("t3");
  });

  it("counts the inbox in the rail", () => {
    attachFakeStore(fixture());
    render(<Rail />);
    const inboxButton = screen.getByText("Inbox").closest("button");
    expect(inboxButton?.textContent).toBe("Inbox2");
  });
});
