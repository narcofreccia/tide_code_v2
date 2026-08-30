import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../vcs/git.ts";
import { createTempRepo, GIT_TEST_ENV, type TempRepo } from "../vcs/testing/tempRepo.ts";
import { globToRegExp, hasRipgrep, isCaseSensitive, search, type SearchResult } from "./search.ts";

const gitFactory = (cwd: string): Git => new Git(cwd, { env: GIT_TEST_ENV });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function corpus(): Promise<TempRepo> {
  const repo = await createTempRepo("tide-search-");
  cleanups.push(() => repo.cleanup());
  await repo.write(".gitignore", "ignored/\n");
  await repo.write("src/alpha.ts", "const needle = 1;\nconst other = 2;\n");
  await repo.write("src/beta.ts", "// NEEDLE in a comment\n");
  await repo.write("docs/notes.md", "the needle again\n");
  await repo.write("ignored/hidden.ts", "needle should not be found\n");
  await repo.writeBytes("blob.bin", Buffer.from([0x6e, 0x00, 0x65]));
  await repo.commit("corpus");
  return repo;
}

/** Runs the assertion against both backends when ripgrep is installed. */
async function bothBackends(
  dir: string,
  options: Parameters<typeof search>[1],
  assert: (result: SearchResult, backend: string) => void,
): Promise<void> {
  assert(await search(dir, { ...options, useRipgrep: false, git: gitFactory }), "node");
  if (await hasRipgrep()) assert(await search(dir, { ...options, useRipgrep: true }), "ripgrep");
}

describe("search", () => {
  it("finds literal matches with 1-based line and column", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "needle" }, (result, backend) => {
      const alpha = result.matches.find((m) => m.path === "src/alpha.ts");
      expect(alpha, backend).toBeDefined();
      expect(alpha?.line).toBe(1);
      expect(alpha?.column).toBe(7);
      expect(alpha?.text).toBe("const needle = 1;");
      expect(result.truncated).toBe(false);
    });
  });

  it("skips gitignored files and binary files", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "needle" }, (result, backend) => {
      expect(result.matches.map((m) => m.path), backend).not.toContain("ignored/hidden.ts");
      expect(result.matches.map((m) => m.path), backend).not.toContain("blob.bin");
    });
  });

  it("is smart-case by default and exact when caseSensitive is set", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "needle" }, (result, backend) => {
      expect(result.matches.map((m) => m.path).sort(), backend).toContain("src/beta.ts");
    });
    await bothBackends(repo.dir, { query: "needle", caseSensitive: true }, (result, backend) => {
      expect(result.matches.map((m) => m.path), backend).not.toContain("src/beta.ts");
    });
    // an uppercase letter in the pattern turns smart-case into a sensitive search
    await bothBackends(repo.dir, { query: "NEEDLE" }, (result, backend) => {
      expect(result.matches.map((m) => m.path), backend).toEqual(["src/beta.ts"]);
    });
  });

  it("supports regular expressions", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "n[e]+dle\\s+=", regex: true }, (result, backend) => {
      expect(result.matches.map((m) => m.path), backend).toEqual(["src/alpha.ts"]);
    });
    await bothBackends(repo.dir, { query: "n[e]+dle" }, (result, backend) => {
      expect(result.matches, backend).toEqual([]);
    });
  });

  it("filters by glob", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "needle", glob: "*.md" }, (result, backend) => {
      expect(result.matches.map((m) => m.path), backend).toEqual(["docs/notes.md"]);
    });
    await bothBackends(repo.dir, { query: "needle", glob: "src/**" }, (result, backend) => {
      expect(result.matches.map((m) => m.path).sort(), backend).toEqual(["src/alpha.ts", "src/beta.ts"]);
    });
  });

  it("truncates at the limit", async () => {
    const repo = await corpus();
    await bothBackends(repo.dir, { query: "needle", limit: 1 }, (result, backend) => {
      expect(result.matches, backend).toHaveLength(1);
      expect(result.truncated, backend).toBe(true);
    });
  });

  it("rejects an invalid regular expression", async () => {
    const repo = await corpus();
    await expect(search(repo.dir, { query: "a(", regex: true, useRipgrep: false })).rejects.toMatchObject({
      code: "invalid-params",
    });
  });
});

describe("search helpers", () => {
  it("implements smart-case", () => {
    expect(isCaseSensitive("needle", undefined)).toBe(false);
    expect(isCaseSensitive("Needle", undefined)).toBe(true);
    expect(isCaseSensitive("needle", true)).toBe(true);
  });

  it("translates globs", () => {
    expect(globToRegExp("*.ts").re.test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").basenameToo).toBe(true);
    expect(globToRegExp("src/**").re.test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**").re.test("docs/a.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").re.test("src/a.ts")).toBe(true);
  });
});

/** A stub `rg` on PATH, so the --json parser is covered even where ripgrep is not installed. */
describe("search (ripgrep parser)", () => {
  it("parses rg --json match events into SearchMatch", async () => {
    const bin = await mkdtemp(join(tmpdir(), "tide-rgstub-"));
    const previousPath = process.env["PATH"] ?? "";
    cleanups.push(async () => {
      process.env["PATH"] = previousPath;
      await rm(bin, { recursive: true, force: true });
    });
    const events = [
      { type: "begin", data: { path: { text: "./src/a.ts" } } },
      {
        type: "match",
        data: {
          path: { text: "./src/a.ts" },
          lines: { text: "  const \u00e9needle = 1;\n" },
          line_number: 7,
          submatches: [{ start: 10 }],
        },
      },
      { type: "match", data: { path: { text: "./bin.dat" }, line_number: 1, submatches: [{ start: 0 }] } },
      { type: "end", data: {} },
    ];
    const script = `#!/bin/sh\nprintf '%s\\n' ${events.map((e) => `'${JSON.stringify(e)}'`).join(" ")}\n`;
    await writeFile(join(bin, "rg"), script);
    await chmod(join(bin, "rg"), 0o755);
    process.env["PATH"] = `${bin}:${previousPath}`;

    const result = await search(process.cwd(), { query: "needle", useRipgrep: true });
    // the binary hit (no `lines`) is dropped; the column is a character offset, not bytes
    expect(result.matches).toEqual([{ path: "src/a.ts", line: 7, column: 10, text: "  const \u00e9needle = 1;" }]);
    expect(result.truncated).toBe(false);
  });
});
