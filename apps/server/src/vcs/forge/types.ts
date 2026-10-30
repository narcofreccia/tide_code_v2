import type { PrDetail, PullRequest } from "@tide/contracts";
import type { PrCreateInput, PrMergeInput } from "../gh.ts";

export type ForgeKind = "github";
export type ReviewEvent = "approve" | "request_changes" | "comment";
export type CheckRun = NonNullable<PullRequest["checkRuns"]>[number];

/** `origin` parsed: `git@github.com:acme/repo.git` and `https://github.com/acme/repo` give the same thing. */
export interface RemoteRef {
  host: string;
  owner: string;
  name: string;
}

export interface ForgeAuth {
  loggedIn: boolean;
  host?: string;
  user?: string;
}

/**
 * One code forge (GitHub today) behind the PR tab, `pr.*` RPCs and PR watch. Every method runs
 * in `repoDir` so the forge CLI resolves the repository from that checkout's `origin`. PRs come
 * back as contract `PullRequest`s whose `updatedAt` is the time Tide read them, not the forge's.
 * Failures throw `GhError` (or the forge's equivalent) carrying the CLI's own message.
 */
export interface Forge {
  readonly kind: ForgeKind;
  /** true when this forge serves `remoteUrl`'s host; call `authStatus()` first so configured enterprise hosts are known */
  detect(remoteUrl: string): boolean;
  authStatus(): Promise<ForgeAuth>;
  /** the logged-in forge user (cached) */
  viewer(): Promise<string | undefined>;
  prList(repoDir: string, opts: { state: "open" | "all"; author?: "@me" }): Promise<PullRequest[]>;
  /** `ref` is a number, a branch or a PR URL; undefined when there is no such PR */
  prView(repoDir: string, ref: string): Promise<PullRequest | undefined>;
  prDetail(repoDir: string, number: number): Promise<PrDetail>;
  /** unified diff of the PR against its base */
  prDiff(repoDir: string, number: number): Promise<string>;
  prCreate(repoDir: string, input: PrCreateInput): Promise<{ url: string; number: number }>;
  prMerge(repoDir: string, number: number, input: PrMergeInput): Promise<void>;
  comment(repoDir: string, number: number, body: string): Promise<void>;
  review(repoDir: string, number: number, event: ReviewEvent, body?: string): Promise<void>;
  /** the tail of a failed check's log, when the forge can produce it */
  failedLog?(repoDir: string, check: CheckRun, maxLines: number): Promise<string | undefined>;
}
