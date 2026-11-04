import { describe, expect, it } from "vitest";
import { emptyReadModel } from "@tide/contracts";
import { eventOf, run } from "./r4.fixtures.ts";

describe("decide: project.update pinned", () => {
  it("passes pinned through in both directions and leaves it out when unset", () => {
    const created = run(emptyReadModel(), { type: "project.create", title: "P", rootPath: "/pin-repo" });
    const projectId = eventOf(created.events, "project.created").project.id;
    const pinned = run(created.model, { type: "project.update", projectId, pinned: true });
    expect(eventOf(pinned.events, "project.updated")).toMatchObject({ projectId, pinned: true });
    expect(pinned.model.projects[projectId]?.pinned).toBe(true);
    const unpinned = run(pinned.model, { type: "project.update", projectId, pinned: false });
    expect(unpinned.model.projects[projectId]?.pinned).toBe(false);
    const titled = run(unpinned.model, { type: "project.update", projectId, title: "Q" });
    expect(eventOf(titled.events, "project.updated").pinned).toBeUndefined();
    expect(titled.model.projects[projectId]).toMatchObject({ title: "Q", pinned: false });
  });

  it("a no-op update still records one project.updated, as it does for title", () => {
    const created = run(emptyReadModel(), { type: "project.create", title: "P", rootPath: "/pin-repo-2" });
    const projectId = eventOf(created.events, "project.created").project.id;
    const { events } = run(created.model, { type: "project.update", projectId });
    expect(events.map((e) => e.type)).toEqual(["project.updated"]);
  });
});

describe("decide: project.update titleInstructions", () => {
  it("sets trimmed instructions, clears them on null or blank, and leaves them alone when omitted", () => {
    const created = run(emptyReadModel(), { type: "project.create", title: "P", rootPath: "/title-repo" });
    const projectId = eventOf(created.events, "project.created").project.id;
    const set = run(created.model, { type: "project.update", projectId, titleInstructions: "  ticket id first " });
    expect(eventOf(set.events, "project.updated")).toMatchObject({ titleInstructions: "ticket id first" });
    expect(set.model.projects[projectId]?.titleInstructions).toBe("ticket id first");
    const renamed = run(set.model, { type: "project.update", projectId, title: "Q" });
    expect(eventOf(renamed.events, "project.updated").titleInstructions).toBeUndefined();
    expect(renamed.model.projects[projectId]?.titleInstructions).toBe("ticket id first");
    const cleared = run(renamed.model, { type: "project.update", projectId, titleInstructions: null });
    expect(eventOf(cleared.events, "project.updated")).toMatchObject({ clearTitleInstructions: true });
    expect(cleared.model.projects[projectId]?.titleInstructions).toBeUndefined();
    const blank = run(set.model, { type: "project.update", projectId, titleInstructions: "  " });
    expect(blank.model.projects[projectId]?.titleInstructions).toBeUndefined();
  });
});
