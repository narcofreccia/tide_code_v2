import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.ts";
import { previewDiff } from "./edit-preview.ts";
import { shellQuote } from "./shell.ts";
import { parseVersion } from "./status.ts";

describe("unifiedDiff", () => {
  it("returns undefined for identical content", () => {
    expect(unifiedDiff("a.txt", "same\n", "same\n")).toBeUndefined();
  });

  it("emits a hunk with context around a replaced line", () => {
    const diff = unifiedDiff("a.txt", "1\n2\n3\n4\n5\n", "1\n2\nthree\n4\n5\n");
    expect(diff).toBe("--- a/a.txt\n+++ b/a.txt\n@@ -1,5 +1,5 @@\n 1\n 2\n-3\n+three\n 4\n 5\n");
  });
});

describe("previewDiff over pi's tool schemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-pi-preview-"));

  it("diffs an `edit` with several entries against the file on disk", () => {
    const file = join(dir, "edit.txt");
    writeFileSync(file, "a\nb\nc\n");
    const diff = previewDiff("edit", {
      path: file,
      edits: [
        { oldText: "a", newText: "A" },
        { oldText: "c", newText: "C" },
      ],
    });
    expect(diff).toContain("+A");
    expect(diff).toContain("+C");
  });

  it("diffs a `write` of a brand-new file", () => {
    expect(previewDiff("write", { path: join(dir, "new.txt"), content: "fresh\n" })).toContain("+fresh");
  });

  it("resolves a relative path against the session cwd", () => {
    writeFileSync(join(dir, "rel.txt"), "old\n");
    expect(previewDiff("write", { path: "rel.txt", content: "new\n" }, dir)).toContain("-old");
  });

  it("gives up rather than guessing", () => {
    expect(previewDiff("edit", { path: join(dir, "edit.txt"), edits: [{ oldText: "not there", newText: "x" }] })).toBeUndefined();
    expect(previewDiff("bash", { command: "ls" })).toBeUndefined();
    expect(previewDiff("write", { path: join(dir, "edit.txt") })).toBeUndefined();
  });
});

describe("shellQuote / parseVersion", () => {
  it("quotes only when needed", () => {
    expect(shellQuote("/tmp/plain-path_1")).toBe("/tmp/plain-path_1");
    expect(shellQuote("/tmp/my repo")).toBe("'/tmp/my repo'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("parses the leading semver of `pi --version`", () => {
    expect(parseVersion("0.84.4\n")).toBe("0.84.4");
    expect(parseVersion("nonsense")).toBeUndefined();
  });
});
