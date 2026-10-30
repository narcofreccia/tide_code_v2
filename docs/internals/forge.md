# Forges (PR tab, PR watch)

Tide reads and acts on pull requests through a **forge**: the code host behind a repo's `origin`.
Only GitHub is implemented, through the user's own `gh` CLI (bring-your-own-login, like the
harnesses). Everything lives in `apps/server/src/vcs/forge/`; the RPCs are in `apps/server/src/rpc/pr.ts`.

## Interface (`forge/types.ts`)

| method | meaning |
|---|---|
| `kind` | `"github"` today |
| `detect(remoteUrl)` | true when this forge serves the remote's host |
| `authStatus()` | `{loggedIn, host?, user?}`; also teaches `detect` the enterprise hosts the user logged into |
| `viewer()` | logged-in login (cached 30 min) |
| `prList(dir, {state, author?})` | `PullRequest[]` |
| `prView(dir, ref)` | ref = number, branch or PR URL; `undefined` when there is no such PR |
| `prDetail(dir, number)` | `PrDetail` (body, files, comments of all three kinds, viewer) |
| `prDiff(dir, number)` | unified diff text, split by `parseUnifiedDiff` (`vcs/diffParse.ts`) into `DiffResult` |
| `prCreate` / `prMerge` | same inputs as the publish flow (`vcs/gh.ts`) |
| `comment(dir, n, body)` / `review(dir, n, event, body?)` | event = `approve \| request_changes \| comment` |
| `failedLog?(dir, check, maxLines)` | tail of a failed CI job's log, when the forge can read it |

Every call runs in a checkout so the CLI resolves the repo from `origin`. A returned
`PullRequest.updatedAt` is when Tide read it (it doubles as "last checked"); the forge's own merge
time is `mergedAt`. Failures throw `GhError` whose message ends with the CLI's first stderr line.

`forge/detect.ts` parses `git remote get-url origin` (https with or without credentials, scp-style
`git@host:owner/name.git`, `ssh://` with a port, `git://`; nested groups keep everything but the last
segment as the owner) into `{host, owner, name}` and picks the first forge whose `detect` accepts
it, asking `authStatus()` first so GitHub Enterprise hosts count. `ForgeResolver` caches the answer
per directory for 10 minutes and is shared by `rpc/pr.ts` and `PrWatcher`.

## GitHub mapping (`forge/github.ts`, `forge/githubMap.ts`)

Commands (all with `GH_PROMPT_DISABLED=1`):

- `gh auth status --json hosts` (exits 0 either way; older gh without `--json`: the exit code of `gh auth status`), cached 5 min
- `gh api user -q .login`
- `gh pr list --json <PR_FIELDS> --state open|all --limit 50 [--author @me]`
- `gh pr view <ref> --json <PR_FIELDS>` and, for detail, `--json <PR_FIELDS>,body,reviews,files`
- `gh api repos/<owner>/<name>/pulls/<n>/comments?per_page=100` (line comments; `gh pr view` has no paths)
- `gh pr diff <n> --color never`
- `gh pr comment <n> --body …`, `gh pr review <n> --approve|--request-changes|--comment [--body …]`
- `gh pr merge <n> --merge|--squash|--rebase [--delete-branch] [--auto]`, `gh pr create …`
- `gh run view --job <job> --log-failed -R <owner>/<name>` (job id from the check's `detailsUrl`)

`PR_FIELDS` = `number,title,url,state,isDraft,author,baseRefName,headRefName,reviewDecision,statusCheckRollup,mergeable,additions,deletions,changedFiles,updatedAt,mergedAt,comments`.

| `PullRequest` | from gh |
|---|---|
| `state` | `OPEN/MERGED/CLOSED` lowercased |
| `title, author, base, head, draft` | `title`, `author.login`, `baseRefName`, `headRefName`, `isDraft` |
| `reviewDecision` | `APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED` lowercased; empty → `none` |
| `mergeable` | `MERGEABLE` → true, `CONFLICTING` → false, `UNKNOWN` → absent |
| `checkRuns[]` | each `statusCheckRollup` entry: name = `name` (CheckRun) or `context` (StatusContext); status: not `COMPLETED` → pending; conclusion `SUCCESS/NEUTRAL/""` → success, `SKIPPED/STALE` → skipped, `FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE` → failure; StatusContext `state` `SUCCESS` → success, failures as above, else pending; url = `detailsUrl` / `targetUrl` |
| `checks` | rollup of `checkRuns`: any failure, else any pending, else success; none → absent |
| `comments` | conversation comments + reviews (list: conversation comments only, it does not fetch reviews) |
| `additions, deletions, changedFiles` | as is |
| `mergedAt` | `Date.parse(mergedAt)` |
| `repo` | `owner/name` from the PR URL |

`PrDetail.comments` merges conversation comments (`kind: comment`), submitted reviews
(`kind: review`, `reviewState` lowercased, pending drafts dropped) and line comments
(`kind: review-comment`, `path`, `line` or `original_line`), oldest first. `files[].status` is
`changeType` lowercased. Fixtures recorded from `pingdotgg/t3code`: `apps/server/test/fixtures/gh/`.

## RPC semantics (`rpc/pr.ts`)

- `pr.list` — every non-archived project (or the one given): the viewer's own PRs
  (`prList(state, @me)`) plus each thread's PR. A thread PR the list does not contain is re-read by
  URL when its stored state is `open` (a merge or close found this way is written back to the
  thread as `pr.update`, state and `mergedAt` only, so PR watch keeps its own diffs); a stored
  merged/closed one is shown for 7 days, or always with `state: "all"`. Items are deduped by
  `owner/name#number` across projects, `threadId` names the thread whose `pr` matches (URL repo or
  `repo` + number), open first then newest. Cached 60 s per `(projectId, state)` unless
  `refresh`; any `pr.*` mutation clears the cache. `viewer` is the gh login.
  Projects whose origin is not on a forge are skipped silently; with an explicit `projectId` they
  fail.
- `pr.detail`, `pr.diff` (`base`/`head` are the PR's branch names), `pr.comment`, `pr.review`.
- `pr.merge` — `deleteBranch` defaults to true. gh can fail after merging (deleting a branch a
  worktree has checked out), so the answer comes from a fresh `prView`: `{merged: true}` or
  `{merged: false, error}`. A linked thread gets `pr.update` at once (so it settles) and its watch
  is switched off.
- `pr.link` — `"#12"`, `"12"` or a PR URL (another repo is fine). Resolves it with `prView`,
  dispatches `pr.update` and, for an open PR, `pr.watch {enabled: true}`.

Errors: `not-found` (unknown project/thread, no such PR), `conflict` (no forge for the origin, or
`gh` missing / not logged in: the message says ``run `gh auth login` ``), `invalid-params` (a
`pr.link` ref that is neither a number nor a PR URL), `internal` (any other gh failure, with gh's
own line). `server.info.tools.ghAuth` carries `gh auth status`.

## PR watch wake-ups (`vcs/prWake.ts`)

One `turn.request` per poll, `notification.source: "pr"`, summary like
`PR #7: CI \`unit (ubuntu)\` failed, changes requested, 2 new comments, conflicts with its base`.
The prompt is `Pull request #7 changed.` followed by one section per change and a closing line
pointing at `gh pr view 7 --comments` / `gh pr checks 7`:

- a check run that is failing now and was not at the last poll (by name; the first one quotes the
  last 40 log lines in a code block, up to 6,000 chars; the others, up to 3, link their URL)
- `reviewDecision` turned `changes_requested`: `Changes requested by @bob:` + the latest such
  review's body quoted, ≤1,500 chars
- comments, reviews with a body and line comments the forge dated after the previous poll, not by
  the viewer (the agent posts through the same account), up to 5, each `@author on \`path:line\`:`
  + body ≤600 chars; none on the first poll of a PR
- the PR became unmergeable (conflict with its base)

CI going from failure to success posts an info activity ("CI on pull request #7 passes again.").

## What GitLab would need

A `GitLabForge` implementing the same interface over `glab` (`glab mr list -F json`, `glab mr view
--output json`, `glab mr diff`, `glab mr note`, `glab mr approve` / `revoke`, `glab mr merge
--squash|--rebase --remove-source-branch`, `glab api projects/:id/merge_requests/:iid/discussions`
for positioned notes, `glab ci trace` for job logs), a mapping table like the one above (pipelines →
`checkRuns`; GitLab has no `changes_requested` decision, only approvals, so `reviewDecision` would
be `approved` / `review_required` / `none`), a `detect` that accepts `gitlab.com` plus the hosts
`glab auth status` lists, and a line in `ForgeKind`. The PR tab, PR watch and resolver would not
change. `ServerInfo.tools.ghAuth` is GitHub-specific and would need a per-forge sibling.
