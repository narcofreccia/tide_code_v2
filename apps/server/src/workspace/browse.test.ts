import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyReadModel } from "@tide/contracts";
import { browseDirectories } from "./browse.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tide-browse-"));
  await mkdir(join(root, "repo", ".git"), { recursive: true });
  await mkdir(join(root, "plain"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file.txt"), "x");
  return root;
}

describe("browseDirectories", () => {
  it("lists directories only, flags repos, hides dotdirs by default", async () => {
    const root = await fixture();
    const res = await browseDirectories(emptyReadModel(), { path: root }, root);
    expect(res.dirs.map((d) => `${d.name}${d.isGitRepo ? "*" : ""}`)).toEqual(["plain", "repo*"]);
    expect(res.isGitRepo).toBe(false);
    expect(res.parent).toBeDefined();
    const hidden = await browseDirectories(emptyReadModel(), { path: root, showHidden: true }, root);
    expect(hidden.dirs.map((d) => d.name)).toContain(".hidden");
  });
  it("defaults to home, rejects relative and missing paths, returns recent project roots", async () => {
    const root = await fixture();
    const model = { ...emptyReadModel(), projects: { p1: { id: "p1", title: "t", rootPath: join(root, "repo"), createdAt: 1, updatedAt: 2 } } };
    const res = await browseDirectories(model, {}, root);
    expect(res.path).toBe(root);
    expect(res.recent).toEqual([join(root, "repo")]);
    await expect(browseDirectories(model, { path: "relative" }, root)).rejects.toMatchObject({ code: "invalid-params" });
    await expect(browseDirectories(model, { path: join(root, "nope") }, root)).rejects.toMatchObject({ code: "not-found" });
  });
});
