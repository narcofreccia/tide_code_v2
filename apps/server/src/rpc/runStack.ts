import type { RunRepo } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { RunSupervisor, type RunSupervisorDeps } from "../run/supervisor.ts";
import type { WorkspaceServices } from "./workspace.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface RunStackDeps {
  engine: Engine;
  workspace: Pick<WorkspaceServices, "ptys" | "ports">;
  /** the project's stack repos with their profiles (run/profiles.ts) */
  profilesFor(projectId: string, rootPath?: string): Promise<RunRepo[]>;
  log?: (msg: string, data?: unknown) => void;
  /** tests inject one with a fake clock */
  supervisor?: RunSupervisor;
  /** extra supervisor deps (timings, host) when the supervisor is built here */
  supervisorOptions?: Partial<RunSupervisorDeps>;
}

/**
 * `run.plan/start/stop/restart` and the `run.subscribe` stream, 1:1 over the RunSupervisor. Returns the
 * supervisor so the server can close it. On registration, every project's stack is checked for
 * services still listening from a previous server life (`external`).
 */
export function registerRunStackHandlers(router: RpcRouter, deps: RunStackDeps): RunSupervisor {
  const supervisor =
    deps.supervisor ??
    new RunSupervisor({
      ptys: deps.workspace.ptys,
      ports: deps.workspace.ports,
      profilesFor: deps.profilesFor,
      model: () => deps.engine.getModel(),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      ...deps.supervisorOptions,
    });
  const requireProject = (projectId: string): void => {
    if (deps.engine.getModel().projects[projectId] === undefined) throw new RpcException("not-found", `unknown project ${projectId}`);
  };
  const planOptions = (input: { threadId?: string; selected?: string[]; pins?: Record<string, number> }) => ({
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.selected !== undefined ? { selected: input.selected } : {}),
    ...(input.pins !== undefined ? { pins: input.pins } : {}),
  });

  router.register("run.plan", async (input) => supervisor.plan(input.projectId, planOptions(input)));

  router.register("run.start", async (input) =>
    supervisor.start(input.projectId, { ...planOptions(input), ...(input.force !== undefined ? { force: input.force } : {}) }),
  );

  router.register("run.stop", async (input) => {
    requireProject(input.projectId);
    await supervisor.stop(input.projectId, input.key);
    return { ok: true };
  });

  router.register("run.restart", async (input) => {
    requireProject(input.projectId);
    return supervisor.restart(input.projectId, input.key);
  });

  router.registerStream("run.subscribe", async (input, _ctx, emit) => {
    requireProject(input.projectId);
    return supervisor.subscribe(input.projectId, emit);
  });

  void (async () => {
    for (const project of Object.values(deps.engine.getModel().projects)) {
      if (project.archivedAt !== undefined) continue;
      await supervisor.markExternal(project.id).catch((err: unknown) => deps.log?.(`[run] external check failed for ${project.id}`, err));
    }
  })();
  return supervisor;
}
