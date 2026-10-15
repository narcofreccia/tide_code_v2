import { describe, expect, it } from "vitest";
import { parsePrStatus, rollupChecks } from "./gh.ts";

describe("PR status parsing", () => {
  it("rolls CI up: failure wins, then pending, then success", () => {
    expect(rollupChecks([])).toBeUndefined();
    expect(rollupChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("success");
    expect(rollupChecks([{ status: "IN_PROGRESS", conclusion: "" }, { state: "SUCCESS" }])).toBe("pending");
    expect(rollupChecks([{ state: "PENDING" }])).toBe("pending");
    expect(rollupChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failure");
    expect(rollupChecks([{ state: "ERROR" }])).toBe("failure");
  });

  it("maps mergeable and counts comments plus reviews", () => {
    const status = parsePrStatus(JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING", statusCheckRollup: [], comments: [{}, {}], reviews: [{}] }));
    expect(status).toEqual({ state: "open", mergeable: false, comments: 3 });
    expect(parsePrStatus(JSON.stringify({ state: "MERGED", mergeable: "UNKNOWN" }))).toEqual({ state: "merged", comments: 0 });
    expect(parsePrStatus(JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" })).mergeable).toBe(true);
  });
});
