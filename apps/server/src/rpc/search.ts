import type { RpcRouter } from "./router.ts";
import type { Engine } from "../orchestration/engine.ts";
import { searchThreads } from "./searchThreads.ts";

export function registerSearchHandlers(router: RpcRouter, deps: { engine: Engine }): void {
  router.register("threads.search", async (input) => ({
    hits: searchThreads(deps.engine.getModel(), { q: input.q, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }),
  }));
}
