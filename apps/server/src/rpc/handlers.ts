import type { EventRecord } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface HandlerDeps {
  engine: Engine;
  store: EventStore;
  environmentId: string;
  version: string;
  startedAt: number;
}

export function registerHandlers(router: RpcRouter, deps: HandlerDeps): void {
  router.register("server.info", async () => ({
    environmentId: deps.environmentId,
    version: deps.version,
    startedAt: deps.startedAt,
  }));

  router.register("orchestration.dispatch", async (input) => {
    try {
      return await deps.engine.dispatch(input.command);
    } catch (err) {
      if (err instanceof CommandError) throw new RpcException(err.code, err.message);
      throw err;
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
