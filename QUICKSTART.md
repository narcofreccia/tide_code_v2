# Tide v2 — Quickstart

Tide drives the coding harnesses you already pay for (Claude Code, Codex, OpenCode, Pi) from
one place: many threads per repo, each in its own git worktree, with per-turn checkpoints,
diff, revert, PR and merge-back. This page gets you from a clone to a first merged change.
What Tide does to your repository is in [`docs/TRIAL.md`](docs/TRIAL.md).

## 1. Prerequisites

- Node 22 (`nvm use` in the repo picks it), pnpm 10.
- At least one harness installed and logged in. Tide never stores provider credentials.

| Harness | Install | Log in | Note |
|---|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` then `/login` | works with Claude Max |
| Codex | `npm i -g @openai/codex` | `codex login` | 0.162+ |
| OpenCode | `npm i -g @opencode/cli` | `opencode auth login` | **2.x only**; 1.x is refused |
| Pi | optional, Tide bundles 1.1 | `pi` then `/login`, or run Ollama | |

- `git` on PATH; `gh` if you want PRs from the Changes tab.
- Desktop app only: Rust toolchain and the Tauri v2 prerequisites for macOS.

## 2. Three ways to launch

### A. Browser (fastest, what the daily dev loop uses)

```sh
cd tide_code_v2
nvm use && pnpm install
pnpm dev
```

This starts the server on `:3777` and the web app on `:5173`. The server prints a line like
`token: a02f7c…` at startup. Open:

```
http://localhost:5173/?token=<that token>
```

The token is remembered by the browser after the first visit. Server state (projects,
threads, worktrees, logs) lives in `~/.tide`. To experiment without touching it:

```sh
TIDE_HOME=/tmp/tide-trial pnpm dev
```

### B. Desktop app from source

```sh
pnpm desktop:sidecar      # compiles the server into a single binary (bun), once per change
pnpm desktop:dev          # Tauri window; boots the sidecar, hands it the token itself
```

No token to paste. Logs are in `~/.tide/logs/server.log`. If the server dies the window
shows a Retry splash after a few backoff attempts.

### C. Installed build

Download the latest `Tide.dmg` from the release endpoint (see `docs/RELEASING.md`), drag to
Applications, open. Same behaviour as B. Updates are checked at launch and every 6 hours.

## 3. First ten minutes

1. **Add a project.** Rail → `+ project`. Pick **New project** to start from nothing (Tide
   creates the folder, `git init -b main`, one empty commit), or **Existing repository** to
   browse to a repo. Start with a new project or a throwaway clone; the real repo comes
   later.
2. **Start a thread.** `⌘N` or the project card's "New thread". Choose the harness, model,
   and mode. Keep **worktree** on. For a first run use mode `auto-accept-edits`: edits are
   automatic, every shell command asks.
3. **Talk.** Type in the composer, `⌘↵` sends. Typing while the agent runs queues the next
   message. Approvals and questions show up as cards in the thread and in the **Inbox** on
   Mission Control (`⌘0`).
4. **Review.** The Workbench (`⌘2` split view) opens on **Changes**: per-turn diff, file list,
   "Revert turn". Files open in Monaco; `` ⌘` `` opens a terminal in the worktree.
5. **Land it.** Changes header → **Commit / PR** (needs `gh` and a remote) or **Merge ▾**
   (squash by default) to merge the thread's branch into the branch you started from. A
   conflict lists the files; resolve in the terminal and retry.
6. **Plan first when it is big.** Set interaction to **plan**: the harness's own plan mode
   produces a Proposed plan card. "Implement in new thread" runs it on any harness, on its
   own worktree. Nothing runs until you click.

## 4. Where things are

| | |
|---|---|
| Server state, settings, logs | `~/.tide` (`server.json`, `settings.json`, `logs/`, `worktrees/`) |
| Thread worktrees | `~/.tide/worktrees/<project>/<thread>/`, branch `tide/<title>` |
| Checkpoints | `refs/tide/checkpoints/…` in your repo (refs only, no commits on your branches) |
| Settings | top bar → Settings: providers, git, appearance, keyboard, remote, decisions |
| Escape hatch | thread header → "Open in terminal" runs `claude --resume <id>` (or the harness's equivalent) in the worktree |

## 5. Keyboard

`⌘K` palette · `⌘N` new thread · `⌘0` Mission Control · `⌘1/2/3` thread / split / workbench ·
`⌘B` rail · `` ⌘` `` terminal · `⌘P` open file · `⌘⇧F` search · `⌘↵` send · `Esc` stop ·
`y`/`n` on a focused approval.

## 6. Checks

```sh
pnpm typecheck && pnpm test     # 1,238 tests
curl localhost:3777/health      # {"ok":true,…}
```

Progress and open questions: `JOURNAL.html`. Architecture: `docs/internals/overview.md`.
