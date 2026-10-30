import type { PrDetail, PullRequest } from "@tide/contracts";
import type { DetectedForge } from "../forge/detect.ts";
import { ForgeResolver } from "../forge/resolver.ts";
import type { CheckRun, Forge, ForgeAuth, ReviewEvent } from "../forge/types.ts";
import type { PrCreateInput, PrMergeInput } from "../gh.ts";

export const prOf = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  url: `https://github.com/acme/repo/pull/${number}`,
  number,
  state: "open",
  updatedAt: 1,
  repo: "acme/repo",
  ...extra,
});

export const detailOf = (pr: PullRequest, extra: Partial<PrDetail> = {}): PrDetail => ({ pr, files: [], comments: [], viewer: "me", ...extra });

/** Scripted forge: answers from what the test set up and records every call. */
export class FakeForge implements Forge {
  readonly kind = "github" as const;
  auth: ForgeAuth = { loggedIn: true, host: "github.com", user: "me" };
  viewerLogin: string | undefined = "me";
  /** `prList` answer (filtered by state) */
  list: PullRequest[] = [];
  /** `prView` answers by ref (number as string, branch or URL); unknown refs fall back to `list` by number */
  views = new Map<string, PullRequest>();
  /** `prDetail` answers per PR number; the last entry repeats; an Error is thrown */
  details = new Map<number, (PrDetail | Error)[]>();
  diffs = new Map<number, string>();
  /** failed-check log tails by check name */
  logs = new Map<string, string>();
  mergeError: Error | undefined;
  /** the state `prView` reports for a PR after `prMerge` ran */
  stateAfterMerge: PullRequest["state"] = "merged";
  calls: { method: string; args: unknown[] }[] = [];
  #merged = new Set<number>();

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  detect(): boolean {
    return true;
  }
  async authStatus(): Promise<ForgeAuth> {
    return this.auth;
  }
  async viewer(): Promise<string | undefined> {
    return this.viewerLogin;
  }
  async prList(repoDir: string, opts: { state: "open" | "all"; author?: "@me" }): Promise<PullRequest[]> {
    this.#record("prList", repoDir, opts);
    return this.list.filter((p) => opts.state === "all" || p.state === "open");
  }
  async prView(repoDir: string, ref: string): Promise<PullRequest | undefined> {
    this.#record("prView", repoDir, ref);
    const found = this.views.get(ref) ?? this.list.find((p) => String(p.number) === ref || p.url === ref);
    if (found !== undefined && this.#merged.has(found.number)) return { ...found, state: this.stateAfterMerge, ...(this.stateAfterMerge === "merged" ? { mergedAt: 5_000 } : {}) };
    return found;
  }
  async prDetail(repoDir: string, number: number): Promise<PrDetail> {
    this.#record("prDetail", repoDir, number);
    const queue = this.details.get(number) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error(`no scripted detail for #${number}`);
    return next;
  }
  async prDiff(repoDir: string, number: number): Promise<string> {
    this.#record("prDiff", repoDir, number);
    return this.diffs.get(number) ?? "";
  }
  async prCreate(repoDir: string, input: PrCreateInput): Promise<{ url: string; number: number }> {
    this.#record("prCreate", repoDir, input);
    return { url: "https://github.com/acme/repo/pull/42", number: 42 };
  }
  async prMerge(repoDir: string, number: number, input: PrMergeInput): Promise<void> {
    this.#record("prMerge", repoDir, number, input);
    if (this.stateAfterMerge === "merged" || this.mergeError === undefined) this.#merged.add(number);
    if (this.mergeError !== undefined) throw this.mergeError;
  }
  async comment(repoDir: string, number: number, body: string): Promise<void> {
    this.#record("comment", repoDir, number, body);
  }
  async review(repoDir: string, number: number, event: ReviewEvent, body?: string): Promise<void> {
    this.#record("review", repoDir, number, event, body);
  }
  async failedLog(repoDir: string, check: CheckRun, maxLines: number): Promise<string | undefined> {
    this.#record("failedLog", repoDir, check.name, maxLines);
    return this.logs.get(check.name);
  }
}

/** A resolver that answers `forge` for every directory (no git remote needed). */
export function fixedResolver(forge: Forge, repo = "acme/repo"): ForgeResolver {
  const [owner = "acme", name = "repo"] = repo.split("/");
  const detected: DetectedForge = { forge, remote: { host: "github.com", owner, name }, repo };
  return new (class extends ForgeResolver {
    override async forDir(): Promise<DetectedForge | undefined> {
      return detected;
    }
  })({ forges: [forge] });
}
