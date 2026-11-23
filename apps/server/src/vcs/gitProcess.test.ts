import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git, GitError, gitEnv, timeoutText } from "./git.ts";
import { GIT_TEST_ENV } from "./testing/tempRepo.ts";

/** How every git process is started: never signing, never prompting, never sitting on stdin, and a timeout that says so. */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A Git whose `git` is the given shell script (POSIX only: the script runs under /bin/sh). */
async function stubGit(script: string, timeoutMs: number): Promise<Git> {
  const bin = await tempDir("tide-gitstub-");
  await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "git"), 0o755);
  return new Git(bin, { env: { ...process.env, PATH: bin }, timeoutMs });
}

/** A global config that signs every commit and tag with an ssh key that does not exist. */
async function signingEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await tempDir("tide-signing-");
  const config = join(dir, "gitconfig");
  await writeFile(
    config,
    `[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${join(dir, "missing_ed25519.pub")}\n`,
  );
  return { ...GIT_TEST_ENV, GIT_CONFIG_GLOBAL: config };
}

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("git process: timeout", () => {
  posixOnly("a git killed by the timeout says so instead of an empty stderr", async () => {
    const git = await stubGit("exec /bin/sleep 5", 200);
    const r = await git.tryRun(["commit", "-m", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toBe(timeoutText(200));
    const err = await git.run(["commit", "-m", "x"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).args).toEqual(["commit", "-m", "x"]);
    expect((err as GitError).message).toBe("git commit -m x failed (1): timed out after 200 ms (git was probably waiting for input: a passphrase, a credential or an editor)");
  });

  posixOnly("an ordinary failure is not reported as a timeout", async () => {
    const git = await stubGit("echo 'fatal: nope' >&2; exit 128", 5_000);
    const r = await git.tryRun(["status"]);
    expect(r).toEqual({ code: 128, stdout: "", stderr: "fatal: nope\n" });
  });

  it("formats seconds and milliseconds", () => {
    expect(timeoutText(120_000)).toMatch(/^timed out after 120 s \(git was probably waiting for input/);
    expect(timeoutText(250)).toMatch(/^timed out after 250 ms /);
  });
});

describe("git process: stdin", () => {
  posixOnly("stdin is ended, so a child that reads it gets end-of-input instead of waiting", async () => {
    // without the end of input `cat` would wait until the 10 s timeout
    const git = await stubGit("/bin/cat >/dev/null; echo read-to-end", 10_000);
    expect(await git.tryRun(["status"])).toEqual({ code: 0, stdout: "read-to-end\n", stderr: "" });
    expect((await git.runBuffer(["status"])).stdout.toString("utf8")).toBe("read-to-end\n");
  });

  posixOnly("argv carries the no-signing config ahead of the caller's args", async () => {
    const git = await stubGit('printf "%s\\n" "$@"', 5_000);
    const argv = (await git.run(["status"])).trim().split("\n");
    expect(argv.slice(0, 6)).toEqual(["-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "push.gpgSign=false"]);
    expect(argv.slice(-2)).toEqual(["--no-pager", "status"]);
  });
});

describe("git process: environment", () => {
  it("never prompts on the terminal and never opens an editor, whatever the caller passes", () => {
    const env = gitEnv({ PATH: "/bin", GIT_EDITOR: "vim", GIT_TERMINAL_PROMPT: "1" }, { GIT_INDEX_FILE: "/tmp/i" });
    expect(env).toEqual({ PATH: "/bin", GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: "/tmp/i" });
  });

  it("a commit that would need an editor fails at once instead of waiting for one", async () => {
    const dir = await tempDir("tide-noeditor-");
    const git = new Git(dir, { env: { ...GIT_TEST_ENV, GIT_EDITOR: "sleep 30" }, timeoutMs: 10_000 });
    await git.run(["init", "-q", "-b", "main"]);
    await git.run(["config", "core.editor", "sleep 30"]);
    const started = Date.now();
    const r = await git.tryRun(["commit", "--allow-empty"]);
    expect(r.timedOut).toBeUndefined();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/empty commit message/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("git process: signing", () => {
  it("commits, merges, rebases and tags even when the user's config signs everything with a key that cannot sign", async () => {
    const env = await signingEnv();
    const dir = await tempDir("tide-nosign-");
    const git = new Git(dir, { env });
    // the raw binary, with the same config, does try to sign (and fails): the config is live
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
    expect(() => execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "raw"], { env, stdio: "pipe" })).toThrow();

    await git.run(["commit", "-q", "--allow-empty", "-m", "root"]);
    await git.run(["checkout", "-q", "-b", "side"]);
    await writeFile(join(dir, "side.txt"), "s\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "side"]);
    await git.run(["checkout", "-q", "main"]);
    await writeFile(join(dir, "main.txt"), "m\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "main"]);
    await git.run(["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    await git.run(["checkout", "-q", "side"]);
    await writeFile(join(dir, "side2.txt"), "s2\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "side 2"]);
    await git.run(["rebase", "-q", "main"]);
    expect(await git.run(["log", "--format=%s", "-n", "2"])).toBe("side 2\nmerge side\n");
    await git.run(["tag", "-a", "-m", "v1", "v1"]);

    expect((await git.run(["log", "--format=%G?", "--all"])).trim().split("\n").every((s) => s === "N")).toBe(true);
    expect(await git.run(["cat-file", "-p", "v1"])).not.toContain("SIGNATURE");
  });
});
