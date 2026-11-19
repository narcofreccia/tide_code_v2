import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { attachmentFooter, readImagePaths, saveAttachments, saveInlineImages, sweepAttachments, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES } from "./attachments.ts";

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

/** The 8-byte PNG signature plus a little padding: enough for the sniffer. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("R22 saveInlineImages", () => {
  const entry = (path: string) => ({ mediaType: "image/png", bytes: PNG.length, name: "image-1.png", path, inline: true });

  it("writes each inline image once, and leaves an existing copy alone", async () => {
    const r = await repo();
    const path = ".tide/attachments/M1/image-1.png";
    const files = [{ mediaType: "application/pdf", bytes: 1, name: "a.pdf", path: ".tide/attachments/U/a.pdf" }];
    expect(await saveInlineImages(r.dir, [...files, entry(path)], [{ mediaType: "image/png", data: PNG.toString("base64") }], { git: git(r.dir) })).toBe(1);
    expect(await readFile(join(r.dir, path))).toEqual(PNG);
    expect(await saveInlineImages(r.dir, [entry(path)], [{ mediaType: "image/png", data: b64("other") }], { git: git(r.dir) })).toBe(0);
    expect(await readFile(join(r.dir, path))).toEqual(PNG);
    expect(await readFile(join(r.dir, ".git", "info", "exclude"), "utf8")).toContain(".tide/");
  });

  it("skips an entry with no matching image (a steer that fell back to a turn)", async () => {
    const dir = await tempDir("tide-inline-");
    expect(await saveInlineImages(dir, [entry(".tide/attachments/M/image-1.png")], undefined)).toBe(0);
    await expect(stat(join(dir, ".tide"))).rejects.toThrow();
  });

  it("refuses a path outside .tide/attachments/", async () => {
    const dir = await tempDir("tide-inline-");
    const image = [{ mediaType: "image/png", data: PNG.toString("base64") }];
    for (const bad of ["x/image-1.png", ".tide/attachments/../../escape.png", "/tmp/x.png"]) {
      await expect(saveInlineImages(dir, [entry(bad)], image)).rejects.toThrow(/outside/);
    }
    await expect(stat(join(dir, "escape.png"))).rejects.toThrow();
  });
});

describe("R22 readImagePaths", () => {
  it("reads a png by relative or absolute path and sniffs its type from the bytes", async () => {
    const dir = await tempDir("tide-img-");
    await mkdir(join(dir, "shots"));
    await writeFile(join(dir, "shots", "a.dat"), PNG);
    const images = await readImagePaths(dir, ["shots/a.dat", join(dir, "shots", "a.dat")]);
    expect(images).toEqual([{ mediaType: "image/png", data: PNG.toString("base64") }, { mediaType: "image/png", data: PNG.toString("base64") }]);
  });

  it("sniffs jpeg, gif and webp", async () => {
    const dir = await tempDir("tide-img-");
    await writeFile(join(dir, "a"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await writeFile(join(dir, "b"), Buffer.from("GIF89a...."));
    await writeFile(join(dir, "c"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));
    expect((await readImagePaths(dir, ["a", "b", "c"])).map((i) => i.mediaType)).toEqual(["image/jpeg", "image/gif", "image/webp"]);
  });

  it("refuses a path outside the checkout, a symlink that escapes it, a missing file and a directory", async () => {
    const dir = await tempDir("tide-img-");
    const outside = await tempDir("tide-img-out-");
    await writeFile(join(outside, "x.png"), PNG);
    await symlink(join(outside, "x.png"), join(dir, "link.png"));
    for (const p of [join(outside, "x.png"), "../x.png", "link.png", "missing.png", "."]) {
      await expect(readImagePaths(dir, [p])).rejects.toMatchObject({ code: "invalid-params", message: expect.stringContaining(p) });
    }
    await mkdir(join(dir, "sub.png"));
    await expect(readImagePaths(dir, ["sub.png"])).rejects.toMatchObject({ code: "invalid-params", message: expect.stringContaining("not a regular file") });
  });

  it("follows a symlink that stays inside the checkout", async () => {
    const dir = await tempDir("tide-img-");
    await writeFile(join(dir, "real.png"), PNG);
    await symlink(join(dir, "real.png"), join(dir, "alias.png"));
    expect(await readImagePaths(dir, ["alias.png"])).toHaveLength(1);
  });

  it("refuses a non-image with a .png name, an oversize file and more than 8 paths", async () => {
    const dir = await tempDir("tide-img-");
    await writeFile(join(dir, "fake.png"), "not an image");
    await expect(readImagePaths(dir, ["fake.png"])).rejects.toMatchObject({ code: "invalid-params", message: expect.stringContaining("not a png, jpeg, gif or webp") });
    await writeFile(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await expect(readImagePaths(dir, ["big.png"])).rejects.toMatchObject({ code: "invalid-params", message: expect.stringContaining("limit") });
    await writeFile(join(dir, "ok.png"), PNG);
    await expect(readImagePaths(dir, Array.from({ length: 9 }, () => "ok.png"))).rejects.toMatchObject({ code: "invalid-params", message: expect.stringContaining("at most 8") });
    expect(await readImagePaths(dir, [])).toEqual([]);
  });
});

describe("R22 attachmentFooter with saved images", () => {
  const image = { mediaType: "image/png", bytes: 2048, name: "image-1.png", path: ".tide/attachments/M/image-1.png", inline: true };
  const file = { mediaType: "application/pdf", bytes: 12, name: "spec.pdf", path: ".tide/attachments/U/spec.pdf" };
  const imagesBlock =
    "\n\nAttached images (also saved on disk):\n- .tide/attachments/M/image-1.png (image/png, 2 KB)\n" +
    "To show one to a sub-agent of your own, put its path in the sub-agent's prompt. " +
    "To show one to another thread, pass its path in `images` to tide_delegate or tide_thread_send.";

  it("files only: unchanged", () => {
    expect(attachmentFooter([file])).toBe("\n\nAttached files (read them from disk):\n- .tide/attachments/U/spec.pdf (application/pdf, 12 B)");
  });

  it("images only: the saved copies and what to do with them", () => {
    expect(attachmentFooter([image])).toBe(imagesBlock);
  });

  it("both: files first, then images", () => {
    expect(attachmentFooter([image, file])).toBe(`\n\nAttached files (read them from disk):\n- .tide/attachments/U/spec.pdf (application/pdf, 12 B)${imagesBlock}`);
  });
});
