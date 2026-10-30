import { describe, expect, it } from "vitest";
import { collect, FIXTURE_HOME, OCT_19, OCT_21, OCT_31, sum } from "../testing/fixtures.ts";
import { scanPi } from "./pi.ts";

describe("pi ingester", () => {
  it("reads assistant usage with Pi's own cost, session id and cwd from the header", async () => {
    const records = await collect(scanPi({ home: FIXTURE_HOME, since: OCT_19, until: OCT_21 }));
    expect(records).toHaveLength(2);
    expect(sum(records)).toEqual({ in: 3100, out: 150, cacheRead: 4000, cacheWrite: 200 });
    expect(records.reduce((a, r) => a + (r.costUsd ?? 0), 0)).toBeCloseTo(0.009);
    expect(records[0]).toMatchObject({ provider: "pi", model: "claude-sonnet-5-5", sessionId: "pi-1", cwd: "/Users/me/proj" });
  });

  it("returns nothing outside the window", async () => {
    expect(await collect(scanPi({ home: FIXTURE_HOME, since: OCT_21, until: OCT_31 }))).toEqual([]);
  });
});
