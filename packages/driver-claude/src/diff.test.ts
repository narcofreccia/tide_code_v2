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

  it("handles pure insertion at the end", () => {
    const diff = unifiedDiff("a.txt", "1\n", "1\n2\n");
    expect(diff).toBe("--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n 1\n+2\n");
  });
});

describe("previewDiff", () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-preview-"));

  it("diffs an Edit against the file on disk", () => {
    const file = join(dir, "edit.txt");
    writeFileSync(file, "alpha\nbeta\n");
    expect(previewDiff("Edit", { file_path: file, old_string: "beta", new_string: "gamma" })).toContain("+gamma");
  });

  it("diffs a Write of a brand-new file", () => {
    const file = join(dir, "new.txt");
    expect(previewDiff("Write", { file_path: file, content: "fresh\n" })).toContain("+fresh");
  });

  it("applies MultiEdit edits in order", () => {
    const file = join(dir, "multi.txt");
    writeFileSync(file, "a\nb\nc\n");
    const diff = previewDiff("MultiEdit", {
      file_path: file,
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "c", new_string: "C" },
      ],
    });
    expect(diff).toContain("+A");
    expect(diff).toContain("+C");
  });

  it("gives up rather than guessing", () => {
    const file = join(dir, "edit.txt");
    expect(previewDiff("Edit", { file_path: file, old_string: "not there", new_string: "x" })).toBeUndefined();
    expect(previewDiff("NotebookEdit", { notebook_path: join(dir, "n.ipynb"), new_source: "x" })).toBeUndefined();
    expect(previewDiff("Bash", { command: "ls" })).toBeUndefined();
  });
});

describe("shellQuote / parseVersion", () => {
  it("quotes only when needed", () => {
    expect(shellQuote("/tmp/plain-path_1")).toBe("/tmp/plain-path_1");
    expect(shellQuote("/tmp/my repo")).toBe("'/tmp/my repo'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("parses the leading semver of `claude --version`", () => {
    expect(parseVersion("2.1.251 (Claude Code)\n")).toBe("2.1.251");
    expect(parseVersion("nonsense")).toBeUndefined();
  });
});
