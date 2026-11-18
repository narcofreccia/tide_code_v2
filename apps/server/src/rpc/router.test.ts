import { describe, expect, it } from "vitest";
import type { RpcFrame } from "@tide/contracts";
import { RpcRouter, type RpcCallContext } from "./router.ts";

/** A router whose `model.get` blocks until its signal aborts, with the same `cancel` handler as handlers.ts. */
function setup(): { router: RpcRouter; seen: RpcCallContext[] } {
  const router = new RpcRouter();
  const seen: RpcCallContext[] = [];
  router.register("cancel", async (input, ctx) => ({ ok: ctx.cancelCall(input.id) }));
  router.register("model.get", (_input, ctx) => {
    seen.push(ctx);
    return new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  return { router, seen };
}

describe("RpcConnection — cancelling unary calls", () => {
  it("cancel aborts the in-flight call's signal and nothing is written for it", async () => {
    const { router, seen } = setup();
    const frames: RpcFrame[] = [];
    const connection = router.connection("c1", (f) => frames.push(f));
    const call = connection.handleRequest("a", "model.get", {});
    expect(seen[0]?.signal.aborted).toBe(false);
    await connection.handleRequest("c", "cancel", { id: "a" });
    await call;
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(frames).toEqual([{ id: "c", result: { ok: true } }]);
    // the call is gone: a second cancel finds nothing
    await connection.handleRequest("c2", "cancel", { id: "a" });
    expect(frames.at(-1)).toEqual({ id: "c2", result: { ok: false } });
  });

  it("cancel of an unknown id answers ok:false, on a client and on an agent socket", async () => {
    const { router } = setup();
    for (const options of [{}, { agentThreadId: "t1" }]) {
      const frames: RpcFrame[] = [];
      const connection = router.connection("c1", (f) => frames.push(f), options);
      await connection.handleRequest("c", "cancel", { id: "nope" });
      expect(frames).toEqual([{ id: "c", result: { ok: false } }]);
    }
  });

  it("close() aborts every in-flight call", async () => {
    const { router, seen } = setup();
    const frames: RpcFrame[] = [];
    const connection = router.connection("c1", (f) => frames.push(f));
    const calls = [connection.handleRequest("a", "model.get", {}), connection.handleRequest("b", "model.get", {})];
    connection.close();
    await Promise.all(calls);
    expect(seen.map((ctx) => ctx.signal.aborted)).toEqual([true, true]);
    expect(frames).toEqual([]);
  });

  it("a finished call leaves nothing to cancel and its signal stays quiet", async () => {
    const { router } = setup();
    const frames: RpcFrame[] = [];
    let signal: AbortSignal | undefined;
    router.register("unsubscribe", async (_input, ctx) => {
      signal = ctx.signal;
      return { ok: true };
    });
    const connection = router.connection("c1", (f) => frames.push(f));
    await connection.handleRequest("a", "unsubscribe", { id: "s" });
    await connection.handleRequest("c", "cancel", { id: "a" });
    connection.close();
    expect(signal?.aborted).toBe(false);
    expect(frames.at(-1)).toEqual({ id: "c", result: { ok: false } });
  });
});
