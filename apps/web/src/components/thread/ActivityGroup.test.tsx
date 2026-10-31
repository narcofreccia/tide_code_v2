import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityGroup, groupToolNames } from "./ActivityGroup.tsx";
import { attachFakeStore, makeThread, makeTool, modelWithTimeline, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const tools = (...names: string[]) => names.map((toolName, i) => makeTool(`a${i}`, { toolName, durationMs: 500 }));

describe("ActivityGroup", () => {
  it("names at most three distinct tools, most recent first", () => {
    expect(groupToolNames(tools("Read", "Grep", "Edit", "Bash", "Read"))).toBe("Read, Bash, Edit…");
    expect(groupToolNames(tools("Read", "Bash"))).toBe("Bash, Read");
    expect(groupToolNames(tools("Read", "Read"))).toBe("");
  });

  it("collapses to one quiet line with count, names and duration, and opens under a rail", () => {
    const activities = tools("Read", "Grep", "Edit", "Bash", "Write");
    attachFakeStore(modelWithTimeline(makeThread("t1"), activities));
    render(
      <ul>
        <ActivityGroup activities={activities} />
      </ul>,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.textContent).toContain("5 tool calls");
    expect(screen.getByText("Write, Bash, Edit…")).toBeDefined();
    expect(toggle.textContent).toContain("2.5s");
    fireEvent.click(toggle);
    expect(screen.getByText("Grep")).toBeDefined();
  });
});
