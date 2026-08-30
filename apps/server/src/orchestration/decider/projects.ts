import type { CommandOf, Project, ReadModel } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type ProjectCommand =
  | CommandOf<"project.create">
  | CommandOf<"project.update">
  | CommandOf<"project.archive">;

export function decideProject(model: ReadModel, command: ProjectCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "project.create": {
      const clash = Object.values(model.projects).find((p) => !isArchived(p) && p.rootPath === command.rootPath);
      if (clash) return fail("conflict", `project already exists for rootPath ${command.rootPath}`);
      const project: Project = {
        id: ctx.newId(),
        title: command.title,
        rootPath: command.rootPath,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "project.created", project });
    }

    case "project.update": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      return ok({
        type: "project.updated",
        projectId: project.id,
        ...(command.title !== undefined ? { title: command.title } : {}),
        updatedAt: ctx.now,
      });
    }

    case "project.archive": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return ok(); // idempotent
      return ok({ type: "project.archived", projectId: project.id, archivedAt: ctx.now });
    }
  }
}
