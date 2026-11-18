import type { MergeStrategy, PullRequest, Thread } from "@tide/contracts";
import type { Git } from "./git.ts";
import { formatCommitMessage } from "./messages.ts";
import { dispatch, generate, gitSettings, info, message, threadContext, type VcsEnv } from "./reactorEnv.ts";

export async function publish(
  env: VcsEnv,
  threadId: string,
  title: string | undefined,
  body: string | undefined,
  commitOnly: boolean,
  mergeWhenGreen: MergeStrategy | undefined,
): Promise<void> {
  const ctx = threadContext(env, threadId);
  if (!ctx) return;
  const git = env.git(ctx.cwd);
  let commitMessage = title ?? `tide: ${ctx.thread.title}`;
  try {
    if (!(await git.isRepo())) {
      await info(env, threadId, "error", `Publish failed: ${ctx.cwd} is not a git repository`);
      return;
    }
    if (title === undefined) commitMessage = await publishCommitMessage(env, git, ctx.thread, commitMessage);
    const sha = await git.commitAll(commitMessage);
    if (commitOnly) {
      await info(env, threadId, "info", sha === undefined ? "Nothing to commit" : `Committed ${sha.slice(0, 8)}`);
      return;
    }
    const branch = ctx.thread.branch ?? (await git.currentBranch());
    if (branch === undefined) {
      await info(env, threadId, "error", "Publish failed: detached HEAD has no branch to push");
      return;
    }
    if (!(await git.hasRemote())) {
      await info(env, threadId, "info", `Committed on ${branch}; no remote configured, nothing pushed`);
      return;
    }
    await git.push(branch);
    const pr = await openOrUpdatePr(env, threadId, ctx.cwd, ctx.thread, branch, title, body);
    if (pr !== undefined && mergeWhenGreen !== undefined) await autoMerge(env, threadId, ctx.cwd, pr, mergeWhenGreen);
    if (pr !== undefined) env.onPrChange?.(threadId);
  } catch (err) {
    await info(env, threadId, "error", `Publish failed: ${message(err)}`);
  }
}

async function openOrUpdatePr(
  env: VcsEnv,
  threadId: string,
  cwd: string,
  thread: Thread,
  branch: string,
  givenTitle: string | undefined,
  givenBody: string | undefined,
): Promise<PullRequest | undefined> {
  if (!(await env.gh.hasGh())) {
    await info(env, threadId, "info", `Pushed ${branch}; install the GitHub CLI to open a pull request`);
    return undefined;
  }
  const existing = await env.gh.prView(cwd, branch);
  let title = givenTitle ?? `tide: ${thread.title}`;
  let body = givenBody;
  if (!existing && (givenTitle === undefined || givenBody === undefined)) {
    const base = thread.baseBranch;
    const generated = await generate(env, { git: env.git(cwd), threadTitle: thread.title, kind: "pr", range: [base !== undefined ? `${base}...HEAD` : "HEAD~1"] });
    if (generated !== undefined) {
      title = givenTitle ?? generated.subject;
      body = givenBody ?? generated.body;
    }
  }
  const pr: PullRequest = existing
    ? { ...existing, updatedAt: env.now() }
    : {
        ...(await env.gh.prCreate(cwd, {
          title,
          ...(body !== undefined ? { body } : {}),
          ...(thread.baseBranch !== undefined ? { base: thread.baseBranch } : {}),
          head: branch,
        })),
        state: "open",
        updatedAt: env.now(),
      };
  await dispatch(env, { type: "pr.update", threadId, pr });
  await info(env, threadId, "info", `${existing ? "Updated" : "Opened"} pull request #${pr.number}`);
  return pr;
}

/** C5: the publish commit (no title given) described from everything the branch will carry. */
async function publishCommitMessage(env: VcsEnv, git: Git, thread: Thread, fallback: string): Promise<string> {
  if (env.oneShot === undefined || !gitSettings(env).generateMessages) return fallback;
  await git.run(["add", "-A"]);
  const generated = await generate(env, { git, threadTitle: thread.title, kind: "commit", range: ["--cached"] });
  return generated === undefined ? fallback : formatCommitMessage(generated);
}

/** publish's `mergeWhenGreen`: GitHub merges the PR once its required checks pass. */
async function autoMerge(env: VcsEnv, threadId: string, cwd: string, pr: PullRequest, strategy: MergeStrategy): Promise<void> {
  if (env.gh.prMerge === undefined) return;
  try {
    await env.gh.prMerge(cwd, pr.number, { strategy, auto: true });
    await info(env, threadId, "info", `Auto-merge (${strategy}) enabled on pull request #${pr.number}`);
  } catch (err) {
    await info(env, threadId, "error", `Auto-merge could not be enabled on #${pr.number}: ${message(err)}`);
  }
}
