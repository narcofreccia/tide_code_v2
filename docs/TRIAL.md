# Trying Tide on a repo you care about

What Tide does to a repository, so you can decide when to point it at a real one.
Present tense; every claim here has a test in `apps/server/src/vcs/` and was run live on
2026-10-12.

## The short version

Tide never edits your checkout. Every thread runs in its **own git worktree** on its **own
branch**. Your working copy, your index and your current branch are left alone until you
press Merge, and even then Tide only fast-forwards a clean checkout.

## What a project is

A project is a path to a repository. Adding it writes nothing into the repo (no hooks, no
config, no files). Tide keeps its own state in `~/.tide` (`TIDE_HOME`).

Starting from nothing: "New project" creates `<parent>/<name>`, runs `git init -b main`, makes
one empty commit (so a worktree can branch from it) and opens the project. It refuses a folder
that already has files in it: adopting an existing folder means a first commit that might
swallow `node_modules/` or a `.env`, so that case stays a manual `git init`.

## What a thread does to the repo

| Action | Where it lands | Touches your checkout? |
|---|---|---|
| New thread (default: worktree on) | `~/.tide/worktrees/<project>/<thread>/`, branch `tide/<thread title>` forked from the branch your checkout is on | no (`git worktree add` only writes under `.git/worktrees/`) |
| Every turn | two snapshot refs `refs/tide/checkpoints/<thread>/<turn>/{before,after}` (tree objects, not commits on any branch) | no |
| Revert a turn | `read-tree --reset` + `clean -fd` **inside the thread's worktree** | no; refused on a thread without a worktree |
| Commit / PR | `git add -A` + commit + push of `tide/<thread>` in the worktree, `gh pr create` | no |
| Merge back (squash / merge / rebase) | done in a temporary worktree of the base branch under `~/.tide/worktrees/.merge-<thread>`; the base branch ref moves only when that succeeds | **fast-forward only, and only if your checkout is clean**. A dirty checkout keeps its files; the completion note gives the one `read-tree` command to sync later |
| Conflict | nothing moves; the thread shows the conflicting files; resolve in the worktree (terminal tab) and retry | no |
| Archive a thread | removes the worktree directory, keeps the branch unless you say otherwise, deletes the checkpoint refs | no |

Threads **without** a worktree (you unticked it, or the folder is not a repo) run in the
checkout itself. Tide disables revert and PR there and says so in the thread.

## Things the harness can still do

The agent is a real Claude Code / Codex / OpenCode / Pi process with your own settings. In
`auto` or `full-access` mode it can run `git` itself, including `git push` or `git checkout`
in the worktree, and a `cd ../.. && …` reaches your checkout like any shell would. Tide does
not sandbox the harness beyond what the harness does. For a first trial use
`approval-required` or `auto-accept-edits`: edits are automatic, every command asks.

Linked repositories (secondary repos a thread may reach) are opened at their real path, not
in a worktree. Read-only links are denied at the harness level; write links are plain
working-tree edits in that repo, with a per-link "revert linked changes" in the Changes tab.

## Clean-up if you stop using Tide

```sh
git worktree prune                       # after deleting ~/.tide/worktrees
git for-each-ref refs/tide/ --format='%(refname)' | xargs -n1 git update-ref -d
git branch --list 'tide/*'               # delete what you don't want
```

## Suggested first hour

1. "New project" from the rail, name it, start a thread on Claude in `auto-accept-edits`,
   ask for a small app. Watch Changes, revert a turn, merge back.
2. Add a throwaway clone of a real repo (`git clone` it somewhere else). Same flow, then
   open a PR from the Changes tab.
3. Only then add the real checkout. Keep `worktree` on, and read the merge note the first
   time your checkout is dirty.
