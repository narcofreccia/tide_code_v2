import { describe, expect, it } from "vitest";
import { ExternalCache, scanExternal, type ExternalResult } from "./external.ts";
import { OCT_19, OCT_21 } from "./testing/fixtures.ts";

const result = (n: string): ExternalResult => ({ buckets: [], notes: [n] });

describe("external scan", () => {
  it("caches per window for five minutes and shares an in-flight scan", async () => {
    let now = 0;
    let calls = 0;
    const cache = new ExternalCache({ now: () => now });
    const compute = async (): Promise<ExternalResult> => result(String(++calls));
    const [a, b] = await Promise.all([cache.get("w", compute), cache.get("w", compute)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    now += 4 * 60_000;
    await cache.get("w", compute);
    expect(calls).toBe(1);
    await cache.get("other", compute);
    expect(calls).toBe(2);
    now += 2 * 60_000;
    expect((await cache.get("w", compute)).notes).toEqual(["3"]);
  });

  it("forgets a failed scan so the next call retries", async () => {
    const cache = new ExternalCache();
    await expect(cache.get("w", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await cache.get("w", async () => result("ok"))).notes).toEqual(["ok"]);
  });

  it("turns an ingester failure into a note instead of failing the page", async () => {
    const r = await scanExternal({
      home: "/nowhere",
      since: OCT_19,
      until: OCT_21,
      exclusion: { sessionIds: new Set(), cwdPrefixes: [] },
      ingesters: [["claude", "Claude Code", async function* () { throw new Error("EACCES"); }]],
    });
    expect(r.notes).toEqual(["Claude Code logs could not be read: EACCES."]);
  });
});
