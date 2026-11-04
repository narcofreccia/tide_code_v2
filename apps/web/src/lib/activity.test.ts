import { describe, expect, it } from "vitest";
import { isEditTool, toolFilePath, toolFilePaths } from "./activity.ts";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("isEditTool", () => {
  it("matches the edit family only", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "patch", "apply_patch"]) expect(isEditTool(name)).toBe(true);
    for (const name of ["Read", "Bash", "NotebookEdit", "edit_file"]) expect(isEditTool(name)).toBe(false);
  });
});

describe("toolFilePaths", () => {
  it("reads the path key harnesses use", () => {
    expect(toolFilePaths({ toolName: "Edit", input: { file_path: "/w/a.ts", old_string: "x" } })).toEqual(["/w/a.ts"]); // Claude
    expect(toolFilePaths({ toolName: "edit", input: { filePath: "src/b.ts" } })).toEqual(["src/b.ts"]); // OpenCode
    expect(toolFilePaths({ toolName: "write", input: { path: "c.ts", content: "" } })).toEqual(["c.ts"]); // Pi
    expect(toolFilePaths({ toolName: "edit", input: { file: "d.ts" } })).toEqual(["d.ts"]);
    expect(toolFilePath({ notebook_path: "n.ipynb" })).toBe("n.ipynb");
  });

  it("parses Codex apply_patch bodies in patch order", () => {
    const body = patch("*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: src/y.ts\n+new");
    expect(toolFilePaths({ toolName: "apply_patch", input: { patch: body } })).toEqual(["src/x.ts", "src/y.ts"]);
    expect(toolFilePaths({ toolName: "apply_patch", input: { input: patch("*** Add File: z.md\n+hi") } })).toEqual(["z.md"]);
  });

  it("returns nothing for opaque or missing input", () => {
    expect(toolFilePaths({ toolName: "apply_patch", input: { patch: "no markers" } })).toEqual([]);
    expect(toolFilePaths({ toolName: "Bash", input: { command: "ls" } })).toEqual([]);
    expect(toolFilePaths({ toolName: "Edit" })).toEqual([]);
    expect(toolFilePaths({ toolName: "Edit", input: "string" })).toEqual([]);
  });
});
