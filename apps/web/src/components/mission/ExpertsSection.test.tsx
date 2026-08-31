import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MissionControl } from "./MissionControl.tsx";
import {
  attachFakeStore,
  makeExpertsSession,
  makeThread,
  modelWith,
  resetUi,
} from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const model = modelWith({
  projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
  threads: {
    loose: makeThread("loose", { title: "Refactor router" }),
    arch: makeThread("arch", { title: "Architect", role: "expert", expertsSessionId: "x1" }),
    lead: makeThread("lead", { title: "Lead", role: "lead", expertsSessionId: "x1", attention: "plan" }),
  },
  expertsSessions: {
    x1: makeExpertsSession("x1", { topic: "Shard the index", lead: { provider: "claude", threadId: "lead" } }),
  },
});

describe("Mission Control experts", () => {
  it("lists sessions with phase, count and needs-you, and keeps expert threads out of the flat list", () => {
    attachFakeStore(model);
    render(<MissionControl />);
    const experts = within(screen.getByLabelText("Experts"));
    expect(experts.getByText("Shard the index")).toBeDefined();
    expect(experts.getByText("Exploring")).toBeDefined();
    expect(experts.getByText("2 experts")).toBeDefined();
    expect(experts.getByText("needs you")).toBeDefined();
    expect(screen.queryByText("Architect")).toBeNull();
    expect(screen.getByText("Refactor router")).toBeDefined();
  });

  it("opens the board from a session row and the dialog from the action", () => {
    attachFakeStore(model);
    render(<MissionControl />);
    fireEvent.click(screen.getByText("New experts session"));
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
    fireEvent.click(screen.getByText("Shard the index"));
    expect(useUi.getState().view).toBe("experts");
    expect(useUi.getState().selectedExpertsSessionId).toBe("x1");
  });
});
