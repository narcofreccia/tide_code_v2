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
