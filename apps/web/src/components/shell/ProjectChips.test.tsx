import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = (id: string, title: string) => ({ id, title, rootPath: `/src/${id}`, createdAt: 1, updatedAt: 1 });

describe("ProjectChips", () => {
  it("is hidden with exactly one project", () => {
    attachFakeStore(modelWith({ projects: { p1: project("p1", "Tide") }, threads: { t1: makeThread("t1") } }));
    render(<Rail />);
    expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
  });

  it("lists All then each live project with its inbox count and running / needs dots", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas"), p3: { ...project("p3", "Gone"), archivedAt: 3 } },
        threads: {
          t1: makeThread("t1", { projectId: "p1", status: "running" }),
          t2: makeThread("t2", { projectId: "p1", attention: "plan" }),
          t3: makeThread("t3", { projectId: "p1", settledAt: 4 }),
          t4: makeThread("t4", { projectId: "p2" }),
        },
      }),
    );
    render(<Rail />);
    const chips = within(screen.getByRole("list", { name: "Projects" }));
    const names = chips.getAllByRole("listitem").map((li) => li.querySelector("button")?.textContent);
    // the letter icon leads each project chip
    expect(names).toEqual(["All", "AAtlas· 1", "TTide· 2"]);
    const tide = within(chips.getByText("Tide").closest("li") as HTMLElement);
    expect(tide.getByRole("img", { name: "running" })).toBeDefined();
    expect(tide.getByRole("img", { name: "needs you" })).toBeDefined();
    const atlas = within(chips.getByText("Atlas").closest("li") as HTMLElement);
    expect(atlas.queryByRole("img", { name: "running" })).toBeNull();
  });

  it("a click scopes the rail to the project; All clears it", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas") },
        threads: { t1: makeThread("t1", { projectId: "p1", title: "Tide work" }), t2: makeThread("t2", { projectId: "p2", title: "Atlas work" }) },
      }),
    );
    render(<Rail />);
    fireEvent.click(screen.getByText("Atlas"));
    expect(useUi.getState().selectedProjectId).toBe("p2");
    expect(screen.queryByText("Tide work")).toBeNull();
    expect(screen.getByText("Atlas work")).toBeDefined();
    expect(screen.getByText("Atlas").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("All"));
    expect(useUi.getState().selectedProjectId).toBeNull();
    expect(screen.getByText("Tide work")).toBeDefined();
  });
});
