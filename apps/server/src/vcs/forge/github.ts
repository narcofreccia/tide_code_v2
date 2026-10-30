import type { PrDetail, PullRequest } from "@tide/contracts";
import { GhError, runGh, type PrCreateInput, type PrMergeInput } from "../gh.ts";
import { parseRemoteUrl } from "./detect.ts";
import { PR_DETAIL_FIELDS, PR_FIELDS, repoOfUrl, toPrDetail, toPullRequest } from "./githubMap.ts";
import type { CheckRun, Forge, ForgeAuth, ReviewEvent } from "./types.ts";

export type GhRunner = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GitHubForgeOptions {
  /** tests replay recorded `gh` output instead of shelling out */
  run?: GhRunner;
  now?: () => number;
}

const AUTH_TTL_MS = 5 * 60_000;
const VIEWER_TTL_MS = 30 * 60_000;
const LIST_LIMIT = "50";
/** `gh pr view` on a branch/number that has no PR; anything else is a real failure */
const NO_PR = /no pull requests? found|could not resolve to a pullrequest|not found/i;
const REVIEW_FLAG: Record<ReviewEvent, string> = { approve: "--approve", request_changes: "--request-changes", comment: "--comment" };

/** GitHub (and GitHub Enterprise hosts the user logged `gh` into), through the `gh` CLI. */
export class GitHubForge implements Forge {
  readonly kind = "github" as const;
  #run: GhRunner;
  #now: () => number;
  #hosts = new Set(["github.com"]);
  #auth: { value: ForgeAuth; at: number } | undefined;
  #viewer: { value: string; at: number } | undefined;

  constructor(options: GitHubForgeOptions = {}) {
    this.#run = options.run ?? runGh;
    this.#now = options.now ?? (() => Date.now());
  }

  detect(remoteUrl: string): boolean {
    const remote = parseRemoteUrl(remoteUrl);
    return remote !== undefined && this.#hosts.has(remote.host);
  }

  /** `gh auth status --json hosts` (always exits 0); also learns the enterprise hosts `detect` accepts. Cached 5 min. */
  async authStatus(): Promise<ForgeAuth> {
    const at = this.#now();
    if (this.#auth !== undefined && at - this.#auth.at < AUTH_TTL_MS) return this.#auth.value;
    const r = await this.#run(["auth", "status", "--json", "hosts"]);
    let value: ForgeAuth = { loggedIn: false };
    if (r.code === 0) {
      try {
        value = this.#parseAuth(JSON.parse(r.stdout) as { hosts?: Record<string, { state?: string; active?: boolean; host?: string; login?: string }[]> });
      } catch {
        value = { loggedIn: false };
      }
    } else if (/unknown flag/i.test(r.stderr)) {
      // gh older than --json: the exit code is the verdict
      value = { loggedIn: (await this.#run(["auth", "status"])).code === 0 };
    }
    this.#auth = { value, at };
    return value;
  }

  #parseAuth(parsed: { hosts?: Record<string, { state?: string; active?: boolean; host?: string; login?: string }[]> }): ForgeAuth {
    let best: ForgeAuth = { loggedIn: false };
    for (const [host, accounts] of Object.entries(parsed.hosts ?? {})) {
      this.#hosts.add(host.toLowerCase());
      for (const account of accounts) {
        if (account.state !== "success") continue;
        const candidate: ForgeAuth = { loggedIn: true, host, ...(account.login !== undefined ? { user: account.login } : {}) };
        // github.com's active account wins over an enterprise one
        if (!best.loggedIn || (account.active === true && (best.host !== "github.com" || host === "github.com"))) best = candidate;
      }
    }
    return best;
  }

  async viewer(): Promise<string | undefined> {
    const at = this.#now();
    if (this.#viewer !== undefined && at - this.#viewer.at < VIEWER_TTL_MS) return this.#viewer.value;
    const r = await this.#run(["api", "user", "-q", ".login"]);
    const login = r.stdout.trim();
    if (r.code !== 0 || login === "") return undefined;
    this.#viewer = { value: login, at };
    return login;
  }

  async prList(repoDir: string, opts: { state: "open" | "all"; author?: "@me" }): Promise<PullRequest[]> {
    const args = ["pr", "list", "--json", PR_FIELDS, "--state", opts.state, "--limit", LIST_LIMIT];
    if (opts.author !== undefined) args.push("--author", opts.author);
    const raw = this.#json(await this.#run(args, repoDir), "gh pr list");
    if (!Array.isArray(raw)) throw new GhError("gh pr list returned no list", JSON.stringify(raw).slice(0, 200));
    const now = this.#now();
    return (raw as Record<string, unknown>[]).flatMap((item) => toPullRequest(item, now) ?? []);
  }

  async prView(repoDir: string, ref: string): Promise<PullRequest | undefined> {
    const r = await this.#run(["pr", "view", ref, "--json", PR_FIELDS], repoDir);
    if (r.code !== 0 && NO_PR.test(r.stderr)) return undefined;
    return toPullRequest(this.#json(r, "gh pr view") as Record<string, unknown>, this.#now());
  }

  async prDetail(repoDir: string, number: number): Promise<PrDetail> {
    const [r, viewer] = await Promise.all([this.#run(["pr", "view", String(number), "--json", PR_DETAIL_FIELDS], repoDir), this.viewer().catch(() => undefined)]);
    const raw = this.#json(r, "gh pr view") as Record<string, unknown>;
    const repo = typeof raw.url === "string" ? repoOfUrl(raw.url) : undefined;
    // line comments: `gh pr view` has no file/line for them; the first 100 are plenty for a review pane
    let lineComments: Record<string, unknown>[] = [];
    if (repo !== undefined) {
      const api = await this.#run(["api", `repos/${repo}/pulls/${number}/comments?per_page=100`], repoDir);
      if (api.code === 0) {
        try {
          const parsed: unknown = JSON.parse(api.stdout);
          if (Array.isArray(parsed)) lineComments = parsed as Record<string, unknown>[];
        } catch {
          // a garbled page leaves the conversation comments, which are still useful
        }
      }
    }
    return toPrDetail(raw, lineComments, this.#now(), viewer);
  }

  async prDiff(repoDir: string, number: number): Promise<string> {
    const r = await this.#run(["pr", "diff", String(number), "--color", "never"], repoDir);
    if (r.code !== 0) throw new GhError("gh pr diff failed", r.stderr);
    return r.stdout;
  }

  async prCreate(repoDir: string, input: PrCreateInput): Promise<{ url: string; number: number }> {
    const args = ["pr", "create", "--title", input.title, "--body", input.body ?? ""];
    if (input.base !== undefined) args.push("--base", input.base);
    if (input.head !== undefined) args.push("--head", input.head);
    const r = await this.#run(args, repoDir);
    if (r.code !== 0) throw new GhError("gh pr create failed", r.stderr);
    const url = r.stdout.trim().split("\n").filter((l) => l.startsWith("http")).pop();
    if (url === undefined) throw new GhError("gh pr create returned no URL", r.stdout);
    const number = Number(url.split("/").pop());
    return { url, number: Number.isFinite(number) ? number : 0 };
  }

  async prMerge(repoDir: string, number: number, input: PrMergeInput): Promise<void> {
    const args = ["pr", "merge", String(number), `--${input.strategy}`];
    if (input.deleteBranch === true) args.push("--delete-branch");
    if (input.auto === true) args.push("--auto");
    const r = await this.#run(args, repoDir);
    if (r.code !== 0) throw new GhError("gh pr merge failed", r.stderr);
  }

  async comment(repoDir: string, number: number, body: string): Promise<void> {
    const r = await this.#run(["pr", "comment", String(number), "--body", body], repoDir);
    if (r.code !== 0) throw new GhError("gh pr comment failed", r.stderr);
  }

  async review(repoDir: string, number: number, event: ReviewEvent, body?: string): Promise<void> {
    const args = ["pr", "review", String(number), REVIEW_FLAG[event]];
    if (body !== undefined && body !== "") args.push("--body", body);
    const r = await this.#run(args, repoDir);
    if (r.code !== 0) throw new GhError("gh pr review failed", r.stderr);
  }

  /** Last `maxLines` of a failed Actions job (`gh run view --job N --log-failed`); undefined for non-Actions checks. */
  async failedLog(repoDir: string, check: CheckRun, maxLines: number): Promise<string | undefined> {
    const m = check.url === undefined ? null : /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(check.url);
    if (m === null || m[1] === undefined || m[2] === undefined) return undefined;
    const r = await this.#run(["run", "view", "--job", m[2], "--log-failed", "-R", m[1]], repoDir);
    if (r.code !== 0) return undefined;
    const lines = r.stdout.split("\n").map(stripLogPrefix).filter((l) => l.trim() !== "");
    return lines.length === 0 ? undefined : lines.slice(-maxLines).join("\n");
  }

  #json(r: { code: number; stdout: string; stderr: string }, what: string): unknown {
    if (r.code !== 0) throw new GhError(`${what} failed`, r.stderr);
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new GhError(`${what} returned unparseable JSON`, r.stdout.slice(0, 200));
    }
  }
}

/** `--log-failed` lines are `job<TAB>step<TAB>2026-…Z text`; the agent needs only the text. */
function stripLogPrefix(line: string): string {
  const parts = line.split("\t");
  const text = parts.length >= 3 ? parts.slice(2).join("\t") : line;
  return text.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
}
