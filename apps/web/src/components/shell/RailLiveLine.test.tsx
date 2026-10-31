import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { attachFakeStore, makeThread, makeTool, makeTurn, modelWithTimeline, resetUi } from "../../testHarness.ts";
import { RailThreadRow } from "./RailThreadRow.tsx";
import { recedes } from "./RailLiveLine.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

function renderRow(thread: Thread, tools: Parameters<typeof makeTool>[1][] = []): HTMLElement {
  const model = modelWithTimeline(thread, tools.map((t, i) => makeTool(`a${i}`, t)));
  model.turns.u1 = makeTurn("u1", { status: thread.status === "running" ? "running" : "completed" });
  attachFakeStore(model);
  return render(
    <ul>
      <RailThreadRow thread={thread} siblings={[thread]} />
    </ul>,
  ).container;
}

const row = (container: HTMLElement): HTMLElement => container.querySelector("[data-rail-thread]") as HTMLElement;

describe("rail row live line", () => {
  it("shows the running tool as a shimmering second line", () => {
    const thread = makeThread("t1", { status: "running", latestTurnId: "u1" });
    const container = renderRow(thread, [{ toolName: "Bash", input: { command: "npm test" }, status: "running" }]);
    const label = screen.getByText("Bash npm test");
    expect(label.closest("[data-live-label]")).not.toBeNull();
    expect(container.querySelector("[data-live-kind]")?.getAttribute("data-live-kind")).toBe("tool");
  });

  it("paints a pending approval in the needs tone with a bell, and replaces the tag line", () => {
    const thread = makeThread("t1", { status: "running", latestTurnId: "u1", attention: "approval", pr: { url: "u", number: 7, state: "open", updatedAt: 1 } });
    const container = renderRow(thread);
    const line = container.querySelector("[data-live-kind]") as HTMLElement;
    expect(line.getAttribute("data-live-kind")).toBe("approval");
    expect(line.textContent).toBe("Needs approval");
    expect(line.querySelector("svg")).not.toBeNull();
    expect(line.querySelector("[data-live-label]")).toBeNull();
    expect(screen.queryByText("PR #7")).toBeNull();
    expect(row(container).hasAttribute("data-recede")).toBe(false);
  });

  it("keeps the tag line for an idle thread, which recedes", () => {
    const thread = makeThread("t1", { latestTurnId: "u1", pr: { url: "u", number: 7, state: "open", updatedAt: 1 } });
    const container = renderRow(thread);
    expect(container.querySelector("[data-live-kind]")).toBeNull();
    expect(screen.getByText("PR #7")).toBeDefined();
    expect(row(container).hasAttribute("data-recede")).toBe(true);
  });

  it("does not recede the selected row", () => {
    useUi.getState().selectThread("t1");
    const container = renderRow(makeThread("t1", { latestTurnId: "u1" }));
    expect(row(container).hasAttribute("data-recede")).toBe(false);
  });
});

describe("recedes", () => {
  const base = { state: "idle" as const, unread: false, active: false, picked: false };
  it("recedes quiet rows only", () => {
    expect(recedes(base)).toBe(true);
    expect(recedes({ ...base, state: "running" })).toBe(true);
    expect(recedes({ ...base, unread: true })).toBe(false);
    expect(recedes({ ...base, active: true })).toBe(false);
    expect(recedes({ ...base, picked: true })).toBe(false);
    expect(recedes({ ...base, state: "needs" })).toBe(false);
    expect(recedes({ ...base, state: "error" })).toBe(false);
    expect(recedes({ ...base, state: "running", live: { text: "Needs approval", kind: "approval" } })).toBe(false);
  });
});
