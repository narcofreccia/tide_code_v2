import { describe, expect, it, afterEach } from "vitest";
import { createTempRepo, type TempRepo } from "../testing/tempRepo.ts";
import { detectForge, parseRemoteUrl } from "./detect.ts";
import { GitHubForge } from "./github.ts";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.cleanup();
});

describe("parseRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/repo.git", "github.com", "acme", "repo"],
    ["https://github.com/acme/repo", "github.com", "acme", "repo"],
    ["https://user:tok@github.com/acme/repo.git/", "github.com", "acme", "repo"],
    ["git@github.com:acme/repo.git", "github.com", "acme", "repo"],
    ["github.com:acme/repo", "github.com", "acme", "repo"],
    ["ssh://git@github.com/acme/repo.git", "github.com", "acme", "repo"],
    ["ssh://git@ghe.acme.io:2222/team/app.git", "ghe.acme.io", "team", "app"],
    ["https://GHE.Acme.io/team/app", "ghe.acme.io", "team", "app"],
    ["git@gitlab.com:group/sub/proj.git", "gitlab.com", "group/sub", "proj"],
  ])("%s", (url, host, owner, name) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, name });
  });

  it("rejects what is not a remote", () => {
    expect(parseRemoteUrl("")).toBeUndefined();
    expect(parseRemoteUrl("/local/path/repo")).toBeUndefined();
    expect(parseRemoteUrl("https://github.com/only-owner")).toBeUndefined();
  });
});

describe("detectForge", () => {
  const offline = new GitHubForge({ run: async () => ({ code: 127, stdout: "", stderr: "gh not found" }) });

  it("finds GitHub from origin, and nothing without one or on another host", async () => {
    const repo = await createTempRepo("tide-forge-");
    repos.push(repo);
    expect(await detectForge(repo.dir, [offline])).toBeUndefined();
    await repo.git.run(["remote", "add", "origin", "git@github.com:acme/repo.git"]);
    const found = await detectForge(repo.dir, [offline]);
    expect(found?.repo).toBe("acme/repo");
    expect(found?.forge.kind).toBe("github");
    await repo.git.run(["remote", "set-url", "origin", "https://gitlab.com/acme/repo.git"]);
    expect(await detectForge(repo.dir, [offline])).toBeUndefined();
  });
});
