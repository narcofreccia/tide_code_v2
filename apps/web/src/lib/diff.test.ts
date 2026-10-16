import { describe, expect, it } from "vitest";
import { cleanDiffHeader, parseUnifiedDiff } from "./diff.ts";

describe("diff headers", () => {
  it("strips a/ b/ prefixes and the doubled slash of an absolute path", () => {
    expect(cleanDiffHeader("--- a//repo/src/x.ts")).toBe("--- /repo/src/x.ts");
    expect(cleanDiffHeader("+++ b//repo/src/x.ts")).toBe("+++ /repo/src/x.ts");
    expect(cleanDiffHeader("--- a/src/x.ts")).toBe("--- src/x.ts");
    expect(cleanDiffHeader("diff --git a/src/x.ts b/src/x.ts")).toBe("diff --git src/x.ts src/x.ts");
  });

  it("leaves /dev/null and body lines alone", () => {
    expect(cleanDiffHeader("--- /dev/null")).toBe("--- /dev/null");
    const lines = parseUnifiedDiff("--- a//r/x\n+++ b//r/x\n@@ -1 +1 @@\n-a//b\n+c");
    expect(lines.map((l) => l.text)).toEqual(["--- /r/x", "+++ /r/x", "@@ -1 +1 @@", "-a//b", "+c"]);
  });
});
