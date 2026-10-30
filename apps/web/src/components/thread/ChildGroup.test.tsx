import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Activity, ActivityOf, Turn } from "@tide/contracts";
import { attachFakeStore, makeThread, makeTurn, modelWithTurns, resetUi } from "../../testHarness.ts";
import { ActivityRow } from "./ActivityRow.tsx";
import { ChildGroup } from "./ChildGroup.tsx";

const base = { threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1 };

const child: ActivityOf<"child"> = {
  ...base,
  id: "c1",
  kind: "child",
  childKey: "task-1",
  name: "explorer",
  description: "map the repo",
  status: "running",
};

const tool: Activity = {
  ...base,
  id: "a1",
  kind: "tool",
  toolUseId: "tu1",
  toolName: "Read",
  input: { file_path: "src/a.ts" },
  status: "running",
  parentToolUseId: "task-1",
};

function setup(status: Turn["status"]): void {
  attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { status })]));
}

afterEach(() => {
  cleanup();
  resetUi();
});

const subagentButton = (): HTMLElement => screen.getByRole("button", { name: /subagent: explorer/ });

describe("ChildGroup settling", () => {
  it("shows a running sub-agent as running while its turn runs", () => {
    setup("running");
    render(
      <ul>
        <ChildGroup child={child} activities={[]} />
      </ul>,
    );
    expect(subagentButton().textContent).toContain("…");
    expect(subagentButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("draws a running sub-agent's label with the live shimmer, a settled one plain", () => {
    setup("running");
    const { container, unmount } = render(
      <ul>
        <ChildGroup child={child} activities={[]} />
      </ul>,
    );
    const live = container.querySelector("[data-live-label]");
    expect(live?.textContent).toContain("subagent: explorer");
    unmount();
    setup("completed");
    const settled = render(
      <ul>
        <ChildGroup child={child} activities={[]} />
      </ul>,
    );
    expect(settled.container.querySelector("[data-live-label]")).toBeNull();
    expect(subagentButton().textContent).toContain("subagent: explorer");
  });

  it.each(["completed", "error", "interrupted"] as const)(
    "renders a still-running sub-agent as done once its turn is %s",
    (status) => {
      setup(status);
      render(
        <ul>
          <ChildGroup child={child} activities={[]} />
        </ul>,
      );
      expect(subagentButton().textContent).toContain("✓");
      expect(subagentButton().textContent).not.toContain("…");
      expect(subagentButton().getAttribute("aria-expanded")).toBe("false");
    },
  );

  it("drops the running mark from a tool row whose turn has settled", () => {
    setup("interrupted");
    render(
      <ul>
        <ActivityRow activity={tool} />
      </ul>,
    );
    const row = screen.getByRole("button", { name: /Read/ }).closest("li");
    expect(row?.textContent).not.toContain("…");
  });

  it("keeps the running mark on a tool row while its turn runs", () => {
    setup("running");
    render(
      <ul>
        <ActivityRow activity={tool} />
      </ul>,
    );
    const row = screen.getByRole("button", { name: /Read/ }).closest("li");
    expect(row?.textContent).toContain("…");
  });
});
