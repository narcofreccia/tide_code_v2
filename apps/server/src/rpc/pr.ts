import type { PrListItem, Project, PullRequest, RpcOutput, Thread } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { parseUnifiedDiff } from "../vcs/diffParse.ts";
import { GhError } from "../vcs/gh.ts";
import { capPatch } from "../vcs/git.ts";
import type { DetectedForge } from "../vcs/forge/detect.ts";
import { repoOfUrl } from "../vcs/forge/githubMap.ts";
import type { ForgeResolver } from "../vcs/forge/resolver.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface PrHandlerDeps {
  engine: Engine;
  forges: ForgeResolver;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

const LIST_TTL_MS = 60_000;
/** a thread's merged/closed PR stays in the open list this long after Tide last saw it */
const RECENT_MS = 7 * 86_400_000;
const NOT_LOGGED_IN = "the GitHub CLI is not installed or not logged in: run `gh auth login`";
const NO_PR = /no pull requests? found|could not resolve to a pullrequest/i;

type ListOutput = RpcOutput<"pr.list">;

const keyOf = (repo: string | undefined, number: number): string => `${repo ?? "?"}#${number}`;

/** GhError → wire error: a missing PR is `not-found`, anything else `internal` with gh's own line. */
function toRpc(err: unknown): never {
  if (err instanceof RpcException) throw err;
  if (err instanceof CommandError) throw new RpcException(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  if (NO_PR.test(message)) throw new RpcException("not-found", message);
  if (err instanceof GhError) throw new RpcException("internal", message);
  throw err;
}

/**
 * `pr.*`: the PR tab over the project repos' forge (GitHub through `gh`). `pr.list` merges the
 * viewer's own open PRs with every thread's PR, cached 60 s; mutations clear that cache.
 */
export function registerPrHandlers(router: RpcRouter, deps: PrHandlerDeps): void {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const listCache = new Map<string, { value: ListOutput; at: number }>();

  const project = (projectId: string): Project => {
    const p = deps.engine.getModel().projects[projectId];
    if (!p) throw new RpcException("not-found", `unknown project ${projectId}`);
    return p;
  };

  /** The forge for a project, or `conflict` when there is none / gh cannot act. */
  const forgeOf = async (p: Project): Promise<DetectedForge> => {
    const detected = await deps.forges.forDir(p.rootPath);
    if (detected === undefined) throw new RpcException("conflict", `${p.title}: origin is not on a supported forge (GitHub)`);
    if (!(await detected.forge.authStatus()).loggedIn) throw new RpcException("conflict", NOT_LOGGED_IN);
    return detected;
  };

  const threadsWithPr = (projectId: string): (Thread & { pr: PullRequest })[] =>
    Object.values(deps.engine.getModel().threads).filter((t): t is Thread & { pr: PullRequest } => t.projectId === projectId && t.archivedAt === undefined && t.pr !== undefined);

  /** Writes a state change the list noticed (merged/closed on the forge) back to the thread; only the state, so PR watch still sees its own diffs. */
  const syncState = async (thread: Thread & { pr: PullRequest }, fresh: PullRequest): Promise<void> => {
    if (fresh.state === thread.pr.state) return;
    const pr: PullRequest = { ...thread.pr, state: fresh.state, updatedAt: now(), ...(fresh.mergedAt !== undefined ? { mergedAt: fresh.mergedAt } : {}) };
    await deps.engine.dispatch({ type: "pr.update", threadId: thread.id, pr }).catch((err: unknown) => log("[pr] state sync rejected", err));
  };

  const listProject = async (p: Project, state: "open" | "all", into: Map<string, PrListItem>): Promise<string | undefined> => {
    const detected = await forgeOf(p);
    const { forge } = detected;
    const threads = threadsWithPr(p.id);
    const owner = new Map<string, string>();
    for (const t of threads) owner.set(keyOf(t.pr.repo ?? repoOfUrl(t.pr.url) ?? detected.repo, t.pr.number), t.id);
    const add = (pr: PullRequest): void => {
      const key = keyOf(pr.repo ?? detected.repo, pr.number);
      const threadId = owner.get(key);
      into.set(key, { projectId: p.id, ...(threadId !== undefined ? { threadId } : {}), pr });
    };
    for (const pr of await forge.prList(p.rootPath, { state, author: "@me" })) add(pr);
    await Promise.all(
      threads.map(async (t) => {
        const key = keyOf(t.pr.repo ?? repoOfUrl(t.pr.url) ?? detected.repo, t.pr.number);
        if (into.has(key)) return;
        if (t.pr.state !== "open") {
          if (state === "all" || now() - t.pr.updatedAt < RECENT_MS) add(t.pr);
          return;
        }
        // the URL resolves even when the PR lives in another repo than origin
        const fresh = await forge.prView(p.rootPath, t.pr.url).catch((err: unknown) => {
          log("[pr] thread PR view failed", { threadId: t.id, err });
          return undefined;
        });
        if (fresh === undefined) return add(t.pr);
        add({ ...fresh, url: t.pr.url });
        await syncState(t, fresh);
      }),
    );
    return forge.viewer().catch(() => undefined);
  };

  router.register("pr.list", async (input) => {
    const state = input.state ?? "open";
    const cacheKey = `${input.projectId ?? "*"}:${state}`;
    const hit = listCache.get(cacheKey);
    if (input.refresh !== true && hit !== undefined && now() - hit.at < LIST_TTL_MS) return hit.value;
    const projects = input.projectId !== undefined ? [project(input.projectId)] : Object.values(deps.engine.getModel().projects).filter((p) => p.archivedAt === undefined);
    const items = new Map<string, PrListItem>();
    const errors: unknown[] = [];
    const logins = await Promise.all(
      projects.map(async (p) => {
        try {
          return await listProject(p, state, items);
        } catch (err) {
          // one project without a forge must not blank the tab for the others
          if (input.projectId !== undefined) toRpc(err);
          if (!(err instanceof RpcException && err.message.includes("not on a supported forge"))) errors.push(err);
          log("[pr] list failed for a project", { projectId: p.id, err: err instanceof Error ? err.message : err });
          return undefined;
        }
      }),
    );
    const viewer = logins.find((l) => l !== undefined);
    if (items.size === 0 && errors.length > 0) toRpc(errors[0]);
    const sorted = [...items.values()].sort((a, b) => Number(b.pr.state === "open") - Number(a.pr.state === "open") || b.pr.number - a.pr.number);
    const value: ListOutput = { items: sorted, fetchedAt: now(), ...(viewer !== undefined ? { viewer } : {}) };
    listCache.set(cacheKey, { value, at: value.fetchedAt });
    return value;
  });

  const withForge = async <T>(projectId: string, fn: (d: DetectedForge, root: string) => Promise<T>): Promise<T> => {
    const p = project(projectId);
    try {
      return await fn(await forgeOf(p), p.rootPath);
    } catch (err) {
      return toRpc(err);
    }
  };

  router.register("pr.detail", (input) => withForge(input.projectId, ({ forge }, root) => forge.prDetail(root, input.number)));

  router.register("pr.diff", (input) =>
    withForge(input.projectId, async ({ forge }, root) => {
      const [text, pr] = await Promise.all([forge.prDiff(root, input.number), forge.prView(root, String(input.number))]);
      if (pr === undefined) throw new RpcException("not-found", `no pull request #${input.number}`);
      return { base: pr.base ?? "base", head: pr.head ?? `#${input.number}`, files: parseUnifiedDiff(text, capPatch) };
    }),
  );

  router.register("pr.comment", (input) =>
    withForge(input.projectId, async ({ forge }, root) => {
      await forge.comment(root, input.number, input.body);
      listCache.clear();
      return { ok: true };
    }),
  );

  router.register("pr.review", (input) =>
    withForge(input.projectId, async ({ forge }, root) => {
      await forge.review(root, input.number, input.event, input.body);
      listCache.clear();
      return { ok: true };
    }),
  );

  router.register("pr.merge", (input) =>
    withForge(input.projectId, async (detected, root) => {
      const { forge } = detected;
      let error: string | undefined;
      try {
        await forge.prMerge(root, input.number, { strategy: input.method, deleteBranch: input.deleteBranch ?? true });
      } catch (err) {
        // gh can fail after merging (deleting a branch a worktree has checked out): the forge decides
        error = err instanceof Error ? err.message : String(err);
      }
      const view = await forge.prView(root, String(input.number)).catch(() => undefined);
      const merged = view?.state === "merged";
      listCache.clear();
      if (view !== undefined) {
        // the linked thread learns at once, so the settlement reactor closes it without waiting for a poll
        for (const t of threadsWithPr(input.projectId)) {
          if (keyOf(t.pr.repo ?? repoOfUrl(t.pr.url) ?? detected.repo, t.pr.number) !== keyOf(view.repo ?? detected.repo, view.number)) continue;
          await deps.engine.dispatch({ type: "pr.update", threadId: t.id, pr: { ...view, url: t.pr.url } });
          if (merged && t.prWatch !== undefined) await deps.engine.dispatch({ type: "pr.watch", threadId: t.id, enabled: false }).catch(() => undefined);
        }
      }
      return merged ? { merged } : { merged, error: error ?? `pull request #${input.number} is ${view?.state ?? "not merged"}` };
    }),
  );

  router.register("pr.link", async (input) => {
    const model = deps.engine.getModel();
    const thread = model.threads[input.threadId];
    if (!thread) throw new RpcException("not-found", `unknown thread ${input.threadId}`);
    const ref = input.pr.trim();
    const number = /^#?(\d+)$/.exec(ref)?.[1];
    if (number === undefined && !/^https?:\/\/\S+\/pull\/\d+\/?$/.test(ref)) throw new RpcException("invalid-params", `"${ref}" is neither a PR number nor a pull request URL`);
    return withForge(thread.projectId, async ({ forge }, root) => {
      const pr = await forge.prView(root, number ?? ref);
      if (pr === undefined) throw new RpcException("not-found", `no pull request ${number !== undefined ? `#${number}` : ref}`);
      await deps.engine.dispatch({ type: "pr.update", threadId: thread.id, pr });
      // watching a merged/closed PR would only switch itself off again
      if (pr.state === "open" && deps.engine.getModel().threads[thread.id]?.prWatch === undefined) {
        await deps.engine.dispatch({ type: "pr.watch", threadId: thread.id, enabled: true });
      }
      listCache.clear();
      return { pr };
    });
  });
}
