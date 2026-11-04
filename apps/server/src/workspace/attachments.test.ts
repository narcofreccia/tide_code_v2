import { mkdtemp, readFile, readdir, realpath, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { attachmentFooter, saveAttachments, sweepAttachments, MAX_TOTAL_BYTES } from "./attachments.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
const git = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });
const b64 = (s: string): string => Buffer.from(s).toString("base64");

async function repo(): Promise<TempRepo> {
  const r = await createTempRepo("tide-att-");
  cleanups.push(() => r.cleanup());
  return r;
}

describe("saveAttachments", () => {
  it("writes under .tide/attachments/<id>/ with cwd-relative refs and dedupes names", async () => {
    const r = await repo();
    const refs = await saveAttachments(r.dir, [
      { name: "spec.pdf", mediaType: "application/pdf", data: b64("hello") },
      { name: "spec.pdf", mediaType: "application/pdf", data: b64("again") },
    ], { git: git(r.dir) });
    expect(refs[0]).toMatchObject({ name: "spec.pdf", mediaType: "application/pdf", bytes: 5 });
    expect(refs[0]?.path).toMatch(/^\.tide\/attachments\/[^/]+\/spec\.pdf$/);
    expect(refs[1]?.name).toBe("spec-2.pdf");
    expect(await readFile(join(r.dir, refs[0]?.path as string), "utf8")).toBe("hello");
  });

  it("refuses path separators, dot names, too many files and > 20 MB", async () => {
    const r = await repo();
    const one = (name: string) => saveAttachments(r.dir, [{ name, mediaType: "text/plain", data: b64("x") }]);
    for (const bad of ["a/b.txt", "..\\x", "../x", "..", ".", "a\0b"]) await expect(one(bad)).rejects.toMatchObject({ code: "invalid-params" });
    await expect(saveAttachments(r.dir, Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, mediaType: "text/plain", data: b64("x") })))).rejects.toMatchObject({ code: "invalid-params" });
    const big = Buffer.alloc(MAX_TOTAL_BYTES / 2 + 1).toString("base64");
    await expect(saveAttachments(r.dir, [{ name: "a", mediaType: "x/y", data: big }, { name: "b", mediaType: "x/y", data: big }])).rejects.toMatchObject({ code: "invalid-params" });
    await expect(readdir(join(r.dir, ".tide"))).rejects.toThrow(); // nothing written on refusal
    expect((await one(".env")).length).toBe(1); // a single leading dot is fine
  });

  it("appends .tide/ to info/exclude once, never touching .gitignore, and for a linked worktree lands in the common dir", async () => {
    const r = await repo();
    await r.write("a.txt", "a");
    await r.commit("init");
    const wt = join(await realpath(await mkdtemp(join(tmpdir(), "tide-att-wt-"))), "wt");
    await git(r.dir).run(["worktree", "add", "-b", "feat", wt]);
    cleanups.push(async () => void (await git(r.dir).tryRun(["worktree", "remove", "--force", wt])));
    const file = (d: string) => saveAttachments(d, [{ name: "a.txt", mediaType: "text/plain", data: b64("x") }], { git: git(d) });
    await file(wt);
    await file(wt);
    await file(r.dir);
    const exclude = await readFile(join(r.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".tide/")).toHaveLength(1);
    expect((await git(wt).tryRun(["status", "--porcelain"])).stdout).not.toContain(".tide");
    await expect(stat(join(r.dir, ".gitignore"))).rejects.toThrow();
  });
});

describe("sweepAttachments", () => {
  it("removes upload dirs older than 30 days only", async () => {
    const r = await repo();
    const [a] = await saveAttachments(r.dir, [{ name: "a", mediaType: "x/y", data: b64("x") }], { git: git(r.dir) });
    const [b] = await saveAttachments(r.dir, [{ name: "b", mediaType: "x/y", data: b64("x") }], { git: git(r.dir) });
    const dirA = join(r.dir, (a?.path as string).split("/").slice(0, 3).join("/"));
    const old = new Date(Date.now() - 31 * 86_400_000);
    await utimes(dirA, old, old);
    expect(await sweepAttachments(r.dir, Date.now())).toBe(1);
    const left = await readdir(join(r.dir, ".tide", "attachments"));
    expect(left).toEqual([(b?.path as string).split("/")[2]]);
    expect(await sweepAttachments(join(r.dir, "nope"), Date.now())).toBe(0);
  });
});

describe("attachmentFooter", () => {
  it("lists files, skips images", () => {
    expect(attachmentFooter([{ mediaType: "image/png", bytes: 3 }])).toBe("");
    expect(attachmentFooter([{ mediaType: "application/pdf", bytes: 1_258_291, name: "spec.pdf", path: ".tide/attachments/X/spec.pdf" }, { mediaType: "text/plain", bytes: 12, name: "n.txt", path: ".tide/attachments/X/n.txt" }]))
      .toBe("\n\nAttached files (read them from disk):\n- .tide/attachments/X/spec.pdf (application/pdf, 1.2 MB)\n- .tide/attachments/X/n.txt (text/plain, 12 B)");
  });
});

describe("pasted text", () => {
  it("counts lines for text media types only", async () => {
    const r = await repo();
    const refs = await saveAttachments(r.dir, [
      { name: "pasted-1.txt", mediaType: "text/plain", data: b64("a\nb\nc\n") },
      { name: "x.bin", mediaType: "application/octet-stream", data: b64("a\nb") },
    ], { git: git(r.dir) });
    expect(refs[0]?.lines).toBe(3);
    expect(refs[1]?.lines).toBeUndefined();
  });

  it("tells the harness what a pasted file is", () => {
    expect(attachmentFooter([{ mediaType: "text/plain", bytes: 12, name: "pasted-1.txt", path: "p/pasted-1.txt", lines: 48 }]))
      .toBe("\n\nAttached files (read them from disk):\n- p/pasted-1.txt (pasted text, 48 lines, 12 B)");
  });
});
