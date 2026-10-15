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
3. **Talk.** Type in the composer, `⌘↵` sends. A message typed while the agent runs is
   steered into the running turn (or queued; see §4). Approvals and questions show up as cards in the thread and in the **Inbox** on
   Mission Control (`⌘0`).
4. **Review.** The Workbench (`⌘2` split view) opens on **Changes**: per-turn diff, file list,
   "Rollback…" and "Fork from here…". Files open in Monaco; `` ⌘` `` opens a terminal in the worktree.
5. **Land it.** Changes header → **Commit / PR** (needs `gh` and a remote) or **Merge ▾**
   (squash by default) to merge the thread's branch into the branch you started from. A
   conflict lists the files; resolve in the terminal and retry.
6. **Plan first when it is big.** Set interaction to **plan**: the harness's own plan mode
   produces a Proposed plan card. "Implement in new thread" runs it on any harness, on its
   own worktree. Nothing runs until you click.

## 4. Working a thread

- **Steer or queue.** While a turn runs, the **Steer | Queue** toggle under the composer sets
  what a message does. Steer delivers it into the running turn; Queue runs it after the turn
  ends. `⌘↵` sends in the other mode. A provider that cannot steer has the toggle disabled and
  every follow-up queues.
- **Queued turns.** The queue list above the composer shows queued messages in order. Each row
  can be edited (✎), moved (↑ ↓) or dragged, promoted with **Send now as steer** (only while a
  turn runs on a harness that can steer), or removed (×).
- **Fork from here.** Starts a new thread from a settled turn, with its own title, harness and
  model. Use the ⋯ menu on the user message, or **Fork from here…** in the Changes tab. Claude,
  Codex, Pi and OpenCode each fork natively; the new worktree branches from that turn's
  after-checkpoint. The thread header shows `forked from <title>`; click it to open the source.
- **Rollback.** Replaces Revert. "Roll back to before this turn" undoes the chosen turn and
  every turn after it. The harness forgets those turns on all four harnesses. "Restore files"
  also resets the thread's worktree to the checkpoint taken before that turn. Rolled-back
  messages are dimmed and tagged `rolled back`.
- **Switching provider.** The next turn after a change of harness carries a **Handoff** card
  (collapsed). It holds verbatim excerpts of earlier turns within a fixed budget; older turns
  are listed as omitted. It is lossy: tool state does not carry over. Switching back to a
  harness that already ran the thread resumes that harness's own session and sends only the
  turns since then.
- **Limited threads.** When a subscription window runs out, the thread shows a `⛔ Limited`
  badge and stops. Its menu offers Resume now, Resume at reset, Wait for me, Snooze 1h and
  Snooze until reset. Mission Control has a Limited section (hidden when empty) and a collapsed
  Snoozed section.
- **PR watch.** In the Changes tab, **Watch PR** (once a PR exists) turns on polling. The
  thread is woken on a CI failure, a new comment or a conflict. Mission Control shows the watch
  state on the thread's card (`👁 PR #n · ✔ · 3 comments`).
- **Settings › General** sets the default follow-up mode (Steer or Queue) and the usage-limit
  policy (Wait for me or Resume at reset).

## 5. Where things are

| | |
|---|---|
| Server state, settings, logs | `~/.tide` (`server.json`, `settings.json`, `logs/`, `worktrees/`) |
| Thread worktrees | `~/.tide/worktrees/<project>/<thread>/`, branch `tide/<title>` |
| Checkpoints | `refs/tide/checkpoints/…` in your repo (refs only, no commits on your branches) |
| Settings | top bar → Settings: providers, git, appearance, keyboard, remote, decisions |
| Escape hatch | thread header → "Open in terminal" runs `claude --resume <id>` (or the harness's equivalent) in the worktree |

## 6. Keyboard

`⌘K` palette · `⌘N` new thread · `⌘0` Mission Control · `⌘1/2/3` thread / split / workbench ·
`⌘B` rail · `` ⌘` `` terminal · `⌘P` open file · `⌘⇧F` search · `⌘↵` send · `Esc` stop ·
`y`/`n` on a focused approval.

## 7. Checks

```sh
pnpm typecheck && pnpm test     # 1,238 tests
curl localhost:3777/health      # {"ok":true,…}
```

Progress and open questions: `JOURNAL.html`. Architecture: `docs/internals/overview.md`.
