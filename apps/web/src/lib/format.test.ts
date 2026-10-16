import { describe, expect, it } from "vitest";
import { plural } from "./format.ts";

describe("plural", () => {
  it("agrees with the count", () => {
    expect(plural(1, "thread")).toBe("1 thread");
    expect(plural(0, "thread")).toBe("0 threads");
    expect(plural(3, "change")).toBe("3 changes");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});
