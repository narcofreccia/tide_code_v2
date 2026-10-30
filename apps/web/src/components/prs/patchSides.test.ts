import { describe, expect, it } from "vitest";
import { patchSides } from "./patchSides.ts";

describe("patchSides", () => {
  it("splits hunks into aligned sides", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10 +10 @@\n-y\n+Y\n\\ No newline at end of file\n";
    expect(patchSides(patch)).toEqual({
      original: "⋯ @@ -1,3 +1,3 @@\na\nb\nc\n⋯ @@ -10 +10 @@\ny",
      modified: "⋯ @@ -1,3 +1,3 @@\na\nB\nc\n⋯ @@ -10 +10 @@\nY",
    });
  });
});
