import { isAbsolute, resolve } from "node:path";
import type { CommandOf, Project, ProjectLink, ReadModel } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type ProjectCommand =
  | CommandOf<"project.create">
  | CommandOf<"project.update">
  | CommandOf<"project.archive">
  | CommandOf<"project.link.add">
  | CommandOf<"project.link.update">
  | CommandOf<"project.link.remove">;

/**
 * Lexical normalisation, so `/repo/`, `/repo/./` and `/repo` are one path. Symlinks are
 * deliberately *not* resolved here — the decider is pure and must not touch the disk; the
 * RPC layer stats (and realpaths) the path before dispatching, see rpc/handlers.ts.
 */
export const normalizeLinkPath = (path: string): string => resolve(path);

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

    case "project.link.add": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
      if (!isAbsolute(command.path)) return fail("invalid-command", `link path ${command.path} must be absolute`);
      const label = command.label.trim();
      if (label === "") return fail("invalid-command", "link label must not be empty");
      const path = normalizeLinkPath(command.path);
      if (path === normalizeLinkPath(project.rootPath)) return fail("conflict", "a link cannot be the project's own root");
      const duplicate = (project.links ?? []).find((l) => normalizeLinkPath(l.path) === path);
      if (duplicate) return fail("conflict", `${path} is already linked to project ${project.id}`);
      const link: ProjectLink = {
        id: ctx.newId(),
        path,
        label,
        ...(command.note !== undefined ? { note: command.note } : {}),
        access: command.access ?? "write",
      };
      return ok({ type: "project.link.added", projectId: project.id, link, updatedAt: ctx.now });
    }

    case "project.link.update": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      const existing = (project.links ?? []).find((l) => l.id === command.linkId);
      if (!existing) return fail("not-found", `unknown link ${command.linkId} on project ${project.id}`);
      if (command.label !== undefined && command.label.trim() === "") return fail("invalid-command", "link label must not be empty");
      const link: ProjectLink = {
        ...existing,
        ...(command.label !== undefined ? { label: command.label.trim() } : {}),
        ...(command.note !== undefined ? { note: command.note } : {}),
        ...(command.access !== undefined ? { access: command.access } : {}),
      };
      return ok({ type: "project.link.updated", projectId: project.id, link, updatedAt: ctx.now });
    }

    case "project.link.remove": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (!(project.links ?? []).some((l) => l.id === command.linkId)) return ok(); // idempotent
      return ok({ type: "project.link.removed", projectId: project.id, linkId: command.linkId, updatedAt: ctx.now });
    }
  }
}
