import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { InboxColumn } from "./InboxColumn.tsx";
import { attachFakeStore, makeApproval, makeThread, makeUserInput, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function fixture() {
  const now = Date.now();
  const model = modelWith({
    projects: { p1: project },
    threads: {
      t1: makeThread("t1", { title: "Two approvals", attention: "approval" }),
      t2: makeThread("t2", {
        title: "Urgent question",
        attention: "question",
        triage: { needsUser: 0.9, stuck: 0.72, urgency: 0.9, at: 1 },
      }),
    },
  });
  model.activities["a1"] = makeApproval("a1", { threadId: "t1", createdAt: now - 10 * 60_000, toolName: "Edit" });
  model.activities["a2"] = makeApproval("a2", { threadId: "t1", createdAt: now - 3 * 60_000, toolName: "Bash", input: { command: "rm -rf build" } });
  model.activities["q1"] = makeUserInput("q1", [{ id: "q", text: "Which db?" }], {
    threadId: "t2",
    createdAt: now - 60_000,
  });
  model.threadTimeline["t1"] = [
    { kind: "activity", id: "a1" },
    { kind: "activity", id: "a2" },
  ];
  model.threadTimeline["t2"] = [{ kind: "activity", id: "q1" }];
  return model;
}

describe("Inbox", () => {
  it("lists every pending approval of a thread, triaged first, then oldest wait first", () => {
    attachFakeStore(fixture());
    render(<InboxColumn />);
    const inbox = screen.getByLabelText("Inbox");
    const items = within(inbox).getAllByRole("article");
    expect(items.map((n) => n.getAttribute("aria-label"))).toEqual([
      "Inbox: Urgent question",
      "Inbox: Two approvals",
      "Inbox: Two approvals",
    ]);
    expect(within(items[1] as HTMLElement).getByLabelText("Approval: Edit")).toBeDefined();
    expect(within(items[2] as HTMLElement).getByLabelText("Approval: Bash")).toBeDefined();
    expect(within(inbox).getByText("Inbox · 3")).toBeDefined();
  });

  it("shows how long each item has been waiting", () => {
    attachFakeStore(fixture());
    render(<InboxColumn />);
    const items = screen.getAllByRole("article");
    expect(within(items[1] as HTMLElement).getByText("waiting 10m")).toBeDefined();
    expect(within(items[2] as HTMLElement).getByText("waiting 3m")).toBeDefined();
  });

  it("flags a possibly stuck thread with the probability, only above the threshold", () => {
    const model = fixture();
    model.threads["t1"] = { ...model.threads["t1"]!, triage: { needsUser: 0.5, stuck: 0.59, urgency: 0.1, at: 1 } };
    attachFakeStore(model);
    render(<InboxColumn />);
    expect(screen.getAllByText(/possibly stuck/).map((n) => n.textContent)).toEqual(["possibly stuck · 72%"]);
  });
});
