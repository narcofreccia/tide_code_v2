import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Activity, Turn } from "@tide/contracts";
import { ActivityRow } from "./ActivityRow.tsx";
import { LiveLabel } from "./LiveLabel.tsx";
import { attachFakeStore, makeThread, makeTurn, modelWithTurns, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const tool = (status: "running" | "ok"): Activity => ({
  id: "a1",
  threadId: "t1",
  turnId: "u1",
  createdAt: 1,
  updatedAt: 1,
  kind: "tool",
  toolUseId: "tu1",
  toolName: "Bash",
  input: { command: "pnpm test" },
  status,
});

function renderRow(activity: Activity, turnStatus: Turn["status"]): HTMLElement {
  attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { status: turnStatus })]));
  return render(
    <ul>
      <ActivityRow activity={activity} />
    </ul>,
  ).container;
}

describe("LiveLabel", () => {
  it("holds its text once in the DOM; the bright copy comes from data-label", () => {
    const { container } = render(<LiveLabel text="Thinking…" />);
    const live = container.querySelector("[data-live-label]") as HTMLElement;
    expect(screen.getByText("Thinking…")).toBe(live);
    expect(live.querySelector("[data-label]")?.getAttribute("data-label")).toBe("Thinking…");
    expect(live.querySelector("[aria-hidden=true]")).not.toBeNull();
    // no IntersectionObserver in jsdom: counts as on screen
    expect(live.style.getPropertyValue("--visible-animation-state")).toBe("running");
  });

  it("shimmers a running tool call's name", () => {
    const container = renderRow(tool("running"), "running");
    expect(container.querySelector("[data-live-label]")?.textContent).toBe("Bash");
  });

  it("goes still once the call finishes, or its turn settled without it", () => {
    expect(renderRow(tool("ok"), "running").querySelector("[data-live-label]")).toBeNull();
    cleanup();
    expect(renderRow(tool("running"), "completed").querySelector("[data-live-label]")).toBeNull();
  });
});
