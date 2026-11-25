import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { resetSettings, useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetSettings();
  useUi.setState({ projectFilter: [] });
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

  it("cmd-click toggles a project into the filter; a plain click is exclusive", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas"), p3: project("p3", "Zed") },
        threads: { t1: makeThread("t1", { projectId: "p1", title: "Tide work" }), t2: makeThread("t2", { projectId: "p2", title: "Atlas work" }), t3: makeThread("t3", { projectId: "p3", title: "Zed work" }) },
      }),
    );
    render(<Rail />);
    fireEvent.click(screen.getByText("Atlas"));
    fireEvent.click(screen.getByText("Tide"), { metaKey: true });
    expect(useUi.getState().projectFilter).toEqual(["p2", "p1"]);
    expect(useUi.getState().selectedProjectId).toBeNull();
    expect(screen.queryByText("Zed work")).toBeNull();
    expect(screen.getByText("Tide work")).toBeDefined();
    expect(screen.getByText("Atlas work")).toBeDefined();
    fireEvent.click(screen.getByText("Atlas"), { ctrlKey: true });
    expect(useUi.getState().selectedProjectId).toBe("p1");
    fireEvent.click(screen.getByText("Zed"));
    expect(useUi.getState().projectFilter).toEqual(["p3"]);
    fireEvent.click(screen.getByText("All"));
    expect(useUi.getState().projectFilter).toEqual([]);
  });

  it("lists pinned projects first with a pin, and the menu pins / unpins", async () => {
    const fake = attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Atlas"), p2: { ...project("p2", "Zed"), pinned: true } },
        threads: { t1: makeThread("t1", { projectId: "p1" }) },
      }),
    );
    render(<Rail />);
    const chips = within(screen.getByRole("list", { name: "Projects" }));
    const names = chips.getAllByRole("listitem").map((li) => li.querySelector("button")?.textContent);
    expect(names[1]).toContain("Zed");
    expect(document.querySelector("[data-chip-pinned]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Zed" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" })));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.update", projectId: "p2", pinned: false }));
  });

  it("shows one chip per repo, named by the project: clones on two machines scope together, counts sum", () => {
    const repo = { remoteUrl: "github.com/acme/web", cloneUrl: "https://github.com/acme/web.git", defaultBranch: "main", detectedAt: 1 };
    attachFakeStore(
      modelWith({
        projects: { p1: { ...project("p1", "web"), repo }, p2: { ...project("p2", "web"), repo, createdAt: 2 }, p3: project("p3", "Atlas") },
        threads: {
          t1: makeThread("t1", { projectId: "p1", title: "One" }),
          t2: makeThread("t2", { projectId: "p2", title: "Two" }),
          t3: makeThread("t3", { projectId: "p3", title: "Three" }),
        },
      }),
    );
    render(<Rail />);
    const chips = within(screen.getByRole("list", { name: "Projects" }));
    expect(chips.getAllByRole("listitem")).toHaveLength(3);
    expect(chips.getByText("web").closest("button")?.textContent).toContain("· 2");
    // the chip carries the project's name; the repo and every clone's path are in its tooltip
    expect(chips.getByText("web").closest("button")?.getAttribute("title")).toBe("acme/web\n/src/p1\n/src/p2");
    fireEvent.click(chips.getByText("web"));
    expect(useUi.getState().projectFilter).toEqual(["p1", "p2"]);
    expect(useUi.getState().selectedProjectId).toBe("p1");
    expect(screen.queryByText("Three")).toBeNull();
    expect(chips.getByText("web").closest("button")?.getAttribute("aria-pressed")).toBe("true");
    // cmd-click on the active repo removes the whole group
    fireEvent.click(chips.getByText("web"), { metaKey: true });
    expect(useUi.getState().projectFilter).toEqual([]);
    fireEvent.click(chips.getByText("Atlas"));
    fireEvent.click(chips.getByText("web"), { metaKey: true });
    expect(useUi.getState().projectFilter).toEqual(["p3", "p1", "p2"]);
  });

  it("brings the clicked project's latest active thread into view, and clears a stale thread when the project has none", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas"), p3: project("p3", "Empty") },
        threads: {
          t1: makeThread("t1", { projectId: "p1", title: "Tide old", updatedAt: 10 }),
          t2: makeThread("t2", { projectId: "p2", title: "Atlas older", updatedAt: 20 }),
          t3: makeThread("t3", { projectId: "p2", title: "Atlas latest", updatedAt: 50 }),
          t4: makeThread("t4", { projectId: "p2", title: "Atlas settled", updatedAt: 100, settledAt: 100 }),
          t5: makeThread("t5", { projectId: "p2", title: "Atlas delegate", parentThreadId: "t3", delegatedBy: "t3", role: "delegate", updatedAt: 90 }),
        },
      }),
    );
    useUi.getState().selectThread("t1");
    render(<Rail />);

    // Clicking Atlas switches the active chat to Atlas's latest active root thread (t3), not settled (t4) or nested delegate (t5)
    fireEvent.click(screen.getByText("Atlas"));
    expect(useUi.getState().selectedThreadId).toBe("t3");
    expect(useUi.getState().view).toBe("thread");

    // Clicking Empty (no threads) clears the stale thread from Atlas so the user isn't left looking at the wrong project
    fireEvent.click(screen.getByText("Empty"));
    expect(useUi.getState().selectedProjectId).toBe("p3");
    expect(useUi.getState().selectedThreadId).toBeNull();
  });

  it("renders a Select dropdown when projectSelector setting is 'select', and still brings the latest thread into view", async () => {
    useSettings.getState().setProjectSelector("select");
    const fake = attachFakeStore(
      modelWith({
        projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas") },
        threads: {
          t1: makeThread("t1", { projectId: "p1", title: "Tide work", updatedAt: 10 }),
          t2: makeThread("t2", { projectId: "p2", title: "Atlas work", updatedAt: 30 }),
        },
      }),
    );
    useUi.getState().selectThread("t1");
    render(<Rail />);

    expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Projects" }).textContent).toContain("All projects");

    chooseOption("Projects", /^Atlas/);
    expect(useUi.getState().selectedProjectId).toBe("p2");
    expect(useUi.getState().selectedThreadId).toBe("t2");
    expect(screen.queryByText("Tide work")).toBeNull();
    expect(screen.getByText("Atlas work")).toBeDefined();

    // Project actions button remains accessible in select mode
    fireEvent.click(screen.getByRole("button", { name: "Actions for Atlas" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Pin" })));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.update", projectId: "p2", pinned: true }));

    chooseOption("Projects", /^All projects/);
    expect(useUi.getState().selectedProjectId).toBeNull();
    expect(screen.getByText("Tide work")).toBeDefined();
  });
});
