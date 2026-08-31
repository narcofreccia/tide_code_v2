import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import {
  attachFakeStore,
  makeExpertsSession,
  makeThread,
  modelWith,
  resetUi,
} from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

afterEach(() => {
  cleanup();
  resetUi();
});

function model() {
  return modelWith({
    projects: { p1: project },
    threads: {
      lead: makeThread("lead", { title: "Lead", role: "lead", expertsSessionId: "x1" }),
      arch: makeThread("arch", { title: "Architect", role: "expert", expertsSessionId: "x1" }),
      loose: makeThread("loose", { title: "Refactor router" }),
      del: makeThread("del", { title: "Bench the writer", role: "delegate", delegatedBy: "loose" }),
    },
    expertsSessions: {
      x1: makeExpertsSession("x1", {
        topic: "Shard the index",
        lead: { provider: "claude", threadId: "lead" },
        experts: [
          { key: "architect", name: "Architect", role: "system design", provider: "claude", status: "working", threadId: "arch" },
        ],
      }),
    },
  });
}

describe("Rail experts group", () => {
  it("lists the session with its phase and expert count, above the loose threads", () => {
    attachFakeStore(model());
    render(<Rail />);
    const group = within(screen.getByText("Experts").closest("div") as HTMLElement);
    expect(group.getByText("Shard the index")).toBeDefined();
    expect(group.getByText("Exploring")).toBeDefined();
    expect(group.getByText("1 experts")).toBeDefined();
  });

  it("nests expert and lead threads under the session with their role glyphs", () => {
    attachFakeStore(model());
    render(<Rail />);
    const sessionRow = screen.getByText("Shard the index").closest("li") as HTMLElement;
    const nested = within(sessionRow);
    expect(nested.getByText("Lead")).toBeDefined();
    expect(nested.getByText("Architect")).toBeDefined();
    expect(nested.getByLabelText("lead").textContent).toBe("★");
    expect(nested.getByLabelText("expert").textContent).toBe("◆");
    // and they are not repeated at the project's top level
    expect(screen.getAllByText("Architect")).toHaveLength(1);
  });

  it("nests a delegate under the thread that delegated it", () => {
    attachFakeStore(model());
    render(<Rail />);
    const parentRow = screen.getByText("Refactor router").closest("li") as HTMLElement;
    expect(within(parentRow).getByText("Bench the writer")).toBeDefined();
    expect(within(parentRow).getByLabelText("delegate").textContent).toBe("↳");
  });

  it("shows needs-you when the lead has a plan waiting", () => {
    const m = model();
    const lead = m.threads.lead;
    if (lead) m.threads.lead = { ...lead, attention: "plan" };
    attachFakeStore(m);
    render(<Rail />);
    expect(screen.getByLabelText("needs you")).toBeDefined();
  });

  it("selects the session and opens the create dialog from + Experts", () => {
    attachFakeStore(model());
    render(<Rail />);
    fireEvent.click(screen.getByText("Shard the index"));
    expect(useUi.getState().view).toBe("experts");
    expect(useUi.getState().selectedExpertsSessionId).toBe("x1");

    fireEvent.click(screen.getByText("+ Experts"));
    expect(useUi.getState().newExpertsProjectId).toBe("p1");
  });
});
