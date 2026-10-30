import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diffParse.ts";
import { GitHubForge, type GhRunner } from "./github.ts";
import { PR_DETAIL_FIELDS, PR_FIELDS, toCheckRun } from "./githubMap.ts";

// recorded from the public pingdotgg/t3code repo (gh 2.96, 2026-10-30); see test/fixtures/gh
const fixture = (name: string): string => readFileSync(new URL(`../../../test/fixtures/gh/${name}`, import.meta.url), "utf8");
const NOW = 1_800_000_000_000;

type Answer = { code?: number; stdout?: string; stderr?: string };
function scripted(answers: (args: string[]) => Answer | undefined) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const run: GhRunner = async (args, cwd) => {
    calls.push({ args, ...(cwd !== undefined ? { cwd } : {}) });
    const a = answers(args) ?? { code: 1, stderr: `unexpected gh ${args.join(" ")}` };
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

describe("GitHubForge over recorded gh output", () => {
  it("maps `gh pr list` into PullRequests", async () => {
    const { run, calls } = scripted((args) => (args[1] === "list" ? { stdout: fixture("pr-list.json") } : undefined));
    const prs = await new GitHubForge({ run, now: () => NOW }).prList("/repo", { state: "open", author: "@me" });
    expect(calls[0]).toEqual({ args: ["pr", "list", "--json", PR_FIELDS, "--state", "open", "--limit", "50", "--author", "@me"], cwd: "/repo" });
    expect(prs).toHaveLength(3);
    const [first, second] = prs;
    expect(first).toMatchObject({
      url: "https://github.com/pingdotgg/t3code/pull/27570",
      number: 27570,
      state: "open",
      updatedAt: NOW,
      title: "fix(web): first reply in a new thread shows without a reload",
      author: "realies",
      base: "main",
      head: "fix/draft-first-reply-hidden",
      draft: false,
      reviewDecision: "none",
      mergeable: true,
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      comments: 0,
      checks: "pending",
      repo: "pingdotgg/t3code",
    });
    expect(first?.mergedAt).toBeUndefined();
    expect(first?.checkRuns).toContainEqual({ name: "Lint", status: "pending", url: expect.stringContaining("/actions/runs/") });
    expect(first?.checkRuns).toContainEqual(expect.objectContaining({ name: "EAS Preview", status: "skipped" }));
    // a commit status (Vercel) is named by its context
    expect(first?.checkRuns).toContainEqual(expect.objectContaining({ name: "Vercel – t3code-marketing", status: "success" }));
    expect(second).toMatchObject({ number: 27569, author: "Gieveppix", comments: 1 });
  });

  it("maps `gh pr view` + line comments into a PrDetail", async () => {
    const { run, calls } = scripted((args) => {
      if (args[0] === "pr" && args[1] === "view") return { stdout: fixture("pr-view.json") };
      if (args[0] === "api" && args[1]?.startsWith("repos/")) return { stdout: fixture("pr-review-comments.json") };
      if (args[0] === "api" && args[1] === "user") return { stdout: "narcofreccia\n" };
      return undefined;
    });
    const detail = await new GitHubForge({ run, now: () => NOW }).prDetail("/repo", 27417);
    expect(calls.map((c) => c.args)).toContainEqual(["pr", "view", "27417", "--json", PR_DETAIL_FIELDS]);
    expect(calls.map((c) => c.args)).toContainEqual(["api", "repos/pingdotgg/t3code/pulls/27417/comments?per_page=100"]);
    expect(detail.viewer).toBe("narcofreccia");
    expect(detail.pr).toMatchObject({
      number: 27417,
      state: "merged",
      mergedAt: Date.parse("2026-10-30T09:10:44Z"),
      base: "t3/streaming-perf-1",
      head: "t3/streaming-perf-2",
      mergeable: false,
      checks: "success",
      comments: 4, // two conversation comments + two reviews
    });
    expect(detail.body).toMatch(/^Every streamed update re-parsed/);
    expect(detail.files).toEqual([
      { path: "apps/web/src/components/ChatMarkdown.tsx", additions: 87, deletions: 42, status: "modified" },
      { path: "apps/web/src/components/chat/markdownStreamBlocks.test.tsx", additions: 61, deletions: 0, status: "added" },
      { path: "apps/web/src/components/chat/markdownStreamBlocks.ts", additions: 43, deletions: 0, status: "added" },
      { path: "apps/web/test/appScenarios.renders.tsx", additions: 3, deletions: 1, status: "modified" },
    ]);
    const kinds = detail.comments.map((c) => c.kind);
    expect(kinds.filter((k) => k === "comment")).toHaveLength(2);
    expect(kinds.filter((k) => k === "review")).toHaveLength(2);
    expect(kinds.filter((k) => k === "review-comment")).toHaveLength(5);
    expect(detail.comments.find((c) => c.kind === "review")).toMatchObject({ author: "macroscopeapp", reviewState: "commented" });
    expect(detail.comments.find((c) => c.kind === "review-comment")).toMatchObject({
      id: "4421174420",
      author: "macroscopeapp[bot]",
      path: "apps/web/src/components/ChatMarkdown.tsx",
      line: 1717,
      createdAt: Date.parse("2026-10-30T06:55:43Z"),
    });
    const times = detail.comments.map((c) => c.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("splits `gh pr diff` into per-file patches with statuses and counts", () => {
    const files = parseUnifiedDiff(fixture("pr-diff.patch"));
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["apps/web/src/components/ChatMarkdown.tsx", "modified", 87, 42],
      ["apps/web/src/components/chat/markdownStreamBlocks.test.tsx", "added", 61, 0],
      ["apps/web/src/components/chat/markdownStreamBlocks.ts", "added", 43, 0],
      ["apps/web/test/appScenarios.renders.tsx", "modified", 3, 1],
    ]);
  });

  it("parses renames, deletions and binaries in a unified diff", () => {
    const text = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "--- not a header",
      "-x",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(text).map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ["new.ts", "old.ts", "renamed", 1, 1, undefined],
      ["gone.txt", undefined, "deleted", 0, 2, undefined],
      ["img.png", undefined, "modified", 0, 0, true],
    ]);
  });

  it("returns undefined for a missing PR but throws real gh failures", async () => {
    const { run } = scripted((args) =>
      args[2] === "nope" ? { code: 1, stderr: 'no pull requests found for branch "nope"' } : args[2] === "1" ? { code: 1, stderr: "HTTP 401: Bad credentials" } : undefined,
    );
    const forge = new GitHubForge({ run });
    expect(await forge.prView("/repo", "nope")).toBeUndefined();
    await expect(forge.prView("/repo", "1")).rejects.toThrow("gh pr view failed: HTTP 401: Bad credentials");
  });

  it("reads auth from `gh auth status --json hosts` and learns enterprise hosts", async () => {
    const hosts = {
      hosts: {
        "github.com": [{ state: "success", active: true, host: "github.com", login: "octo" }],
        "ghe.acme.io": [{ state: "success", active: true, host: "ghe.acme.io", login: "octo-corp" }],
      },
    };
    const { run, calls } = scripted((args) => (args[0] === "auth" ? { stdout: JSON.stringify(hosts) } : undefined));
    const forge = new GitHubForge({ run, now: () => NOW });
    expect(forge.detect("git@ghe.acme.io:team/app.git")).toBe(false);
    expect(await forge.authStatus()).toEqual({ loggedIn: true, host: "github.com", user: "octo" });
    expect(forge.detect("git@ghe.acme.io:team/app.git")).toBe(true);
    expect(forge.detect("https://gitlab.com/team/app.git")).toBe(false);
    await forge.authStatus();
    expect(calls).toHaveLength(1); // cached

    const loggedOut = scripted(() => ({ stdout: JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, host: "github.com", login: "octo" }] } }) }));
    expect(await new GitHubForge({ run: loggedOut.run }).authStatus()).toEqual({ loggedIn: false });
    const noGh = scripted(() => ({ code: 127, stderr: "spawn gh ENOENT" }));
    expect(await new GitHubForge({ run: noGh.run }).authStatus()).toEqual({ loggedIn: false });
  });

  it("caches the viewer and builds review/comment/merge/log commands", async () => {
    const log = ["unit (ubuntu)\tRun tests\t2026-10-30T09:00:00.0000000Z FAIL src/a.test.ts", "unit (ubuntu)\tRun tests\t2026-10-30T09:00:01.0000000Z expected 1, got 2"].join("\n");
    const { run, calls } = scripted((args) => (args[0] === "api" ? { stdout: "octo\n" } : args[0] === "run" ? { stdout: log } : {}));
    const forge = new GitHubForge({ run, now: () => NOW });
    expect(await forge.viewer()).toBe("octo");
    expect(await forge.viewer()).toBe("octo");
    await forge.review("/repo", 3, "approve");
    await forge.review("/repo", 3, "request_changes", "split it");
    await forge.comment("/repo", 3, "thanks");
    await forge.prMerge("/repo", 3, { strategy: "squash", deleteBranch: true });
    const tail = await forge.failedLog("/repo", { name: "unit (ubuntu)", status: "failure", url: "https://github.com/acme/repo/actions/runs/11/job/22" }, 1);
    expect(await forge.failedLog("/repo", { name: "vercel", status: "failure", url: "https://vercel.com/x" }, 40)).toBeUndefined();
    expect(tail).toBe("expected 1, got 2");
    expect(calls.map((c) => c.args)).toEqual([
      ["api", "user", "-q", ".login"],
      ["pr", "review", "3", "--approve"],
      ["pr", "review", "3", "--request-changes", "--body", "split it"],
      ["pr", "comment", "3", "--body", "thanks"],
      ["pr", "merge", "3", "--squash", "--delete-branch"],
      ["run", "view", "--job", "22", "--log-failed", "-R", "acme/repo"],
    ]);
  });

  it("classifies rollup entries", () => {
    expect(toCheckRun({ name: "a", status: "COMPLETED", conclusion: "FAILURE" }).status).toBe("failure");
    expect(toCheckRun({ name: "a", status: "COMPLETED", conclusion: "CANCELLED" }).status).toBe("failure");
    expect(toCheckRun({ name: "a", status: "COMPLETED", conclusion: "NEUTRAL" }).status).toBe("success");
    expect(toCheckRun({ name: "a", status: "QUEUED", conclusion: "" }).status).toBe("pending");
    expect(toCheckRun({ context: "ci/legacy", state: "ERROR", targetUrl: "https://ci" })).toEqual({ name: "ci/legacy", status: "failure", url: "https://ci" });
    expect(toCheckRun({ context: "ci/legacy", state: "PENDING" }).status).toBe("pending");
  });
});
