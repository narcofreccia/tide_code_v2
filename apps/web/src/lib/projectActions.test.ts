import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@tide/contracts";
import { addProject, archivedProjectAt } from "./projectActions.ts";
import { attachFakeStore, modelWith, resetUi } from "../testHarness.ts";

afterEach(() => resetUi());

const gone: Project = { id: "p2", title: "Old", rootPath: "/src/old", createdAt: 1, updatedAt: 1, archivedAt: 5 };
const live: Project = { id: "p1", title: "Live", rootPath: "/src/live", createdAt: 1, updatedAt: 1 };

describe("project actions", () => {
  it("finds an archived project by path, trailing slash or not", () => {
    const model = modelWith({ projects: { p1: live, p2: gone } });
    expect(archivedProjectAt(model, "/src/old/")?.id).toBe("p2");
    expect(archivedProjectAt(model, "/src/live")).toBeUndefined();
  });

  it("matches a Windows root whatever its trailing separator or case", () => {
    const win: Project = { ...gone, id: "p3", rootPath: "C:\\src\\Old" };
    const model = modelWith({ projects: { p3: win } });
    expect(archivedProjectAt(model, "c:\\src\\old\\")?.id).toBe("p3");
    expect(archivedProjectAt(model, "C:/src/Old")?.id).toBe("p3");
    expect(archivedProjectAt(model, "C:\\src\\Older")).toBeUndefined();
  });

  it("adding an archived project's path restores it instead of creating a duplicate", async () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: live, p2: gone } }));
    await expect(addProject("Old again", "/src/old")).resolves.toBe("restored");
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.unarchive", projectId: "p2" }));
    expect(fake.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "project.create" }));
  });

  it("creates a project for a new path", async () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: live, p2: gone } }));
    await expect(addProject("New", "/src/new")).resolves.toBe("created");
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.create", title: "New", rootPath: "/src/new" }));
  });
});
