import { isInternalCommand, type EventRecord } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { threadCwd } from "../provider/sessions.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface HandlerDeps {
  engine: Engine;
  store: EventStore;
  registry: DriverRegistry;
  environmentId: string;
  version: string;
  startedAt: number;
  tideHome?: string;
  tools?: { git: boolean; gh: boolean; rg: boolean };
}

export function registerHandlers(router: RpcRouter, deps: HandlerDeps): void {
  router.register("server.info", async () => ({
    environmentId: deps.environmentId,
    version: deps.version,
    startedAt: deps.startedAt,
    ...(deps.tideHome !== undefined ? { tideHome: deps.tideHome, worktreeRoot: `${deps.tideHome}/worktrees` } : {}),
    ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
  }));

  router.register("orchestration.dispatch", async (input) => {
    // The schema already accepts only ClientCommand; this is the belt to that brace.
    const type = input.command.type;
    if (isInternalCommand(input.command)) {
      throw new RpcException("forbidden", `${type} is a server-internal command`);
    }
    try {
      return await deps.engine.dispatch(input.command);
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
    }
  });

  router.register("providers.list", async (input) => deps.registry.statusAll(input.refresh ?? false));

  router.register("thread.terminalCommand", async (input) => {
    const model = deps.engine.getModel();
    const thread = model.threads[input.threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${input.threadId}`);
    const project = model.projects[thread.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${thread.projectId}`);
    const cwd = threadCwd(thread, project);
    if (thread.nativeSessionId === undefined) return { cwd };
    try {
      const instance = await deps.registry.get(thread.provider);
      const command = instance.terminalCommand(thread.nativeSessionId, cwd);
      return command === undefined ? { cwd } : { cwd, command };
    } catch {
      // no driver for this harness on this machine: still tell the client where it lives
      return { cwd };
    }
  });

  router.register("model.get", async () => deps.engine.getModel());

  router.registerStream("model.subscribe", async (input, _ctx, emit) => {
    // Subscribe before reading state, buffering anything that lands while we
    // build the catch-up frames, so no event can slip through the gap.
    let live = false;
    let lastSeq = input.fromSeq !== undefined && input.fromSeq >= 0 ? input.fromSeq : -1;
    const buffered: EventRecord[] = [];
    const push = (record: EventRecord): void => {
      if (record.seq <= lastSeq) return;
      lastSeq = record.seq;
      emit({ kind: "event", record });
    };
    const unsubscribe = deps.engine.subscribe((record) => {
      if (live) push(record);
      else buffered.push(record);
    });

    if (input.fromSeq !== undefined && input.fromSeq >= 0) {
      for (const record of deps.store.readFrom(input.fromSeq + 1)) push(record);
    } else {
      const model = deps.engine.getModel();
      lastSeq = model.seq;
      emit({ kind: "snapshot", model });
    }

    live = true;
    for (const record of buffered) push(record);
    return unsubscribe;
  });

  router.register("unsubscribe", async (input, ctx) => ({ ok: ctx.cancelStream(input.id) }));
}
