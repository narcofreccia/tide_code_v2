import { describe, expect, it } from "vitest";
import { HOOK_TTL_MS, HookStore } from "./hooks.ts";

const hook = (id: string, receivedAt: number, envId = "e1") => ({ id, envId, hookId: "h", headers: { "x-sig": id }, body: Buffer.from(id), receivedAt });

describe("HookStore", () => {
  it("returns held hooks per environment in arrival order", () => {
    const store = new HookStore(":memory:", () => 0);
    store.put(hook("a", 0));
    store.put(hook("z", 0, "e2"));
    store.put(hook("b", 0));
    const first = store.next("e1");
    expect(first).toMatchObject({ id: "a", headers: { "x-sig": "a" } });
    expect(first?.body.toString()).toBe("a");
    store.remove(first!.seq);
    expect(store.next("e1")?.id).toBe("b");
    expect(store.pending("e2")).toBe(1);
    store.close();
  });

  it("drops hooks and delivery ids older than 24 h", () => {
    let now = 1_000;
    const store = new HookStore(":memory:", () => now);
    store.put(hook("old", now));
    expect(store.seen("e1", "d1")).toBe(false);
    now += HOOK_TTL_MS;
    expect(store.next("e1")).toBeUndefined();
    expect(store.seen("e1", "d1")).toBe(false);
    store.close();
  });

  it("dedupes delivery ids per environment and forgets them on unsee", () => {
    const store = new HookStore(":memory:", () => 5);
    expect(store.seen("e1", "d")).toBe(false);
    expect(store.seen("e1", "d")).toBe(true);
    expect(store.seen("e2", "d")).toBe(false);
    store.unsee("e1", "d");
    expect(store.seen("e1", "d")).toBe(false);
    store.close();
  });
});
