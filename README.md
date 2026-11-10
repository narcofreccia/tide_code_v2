# Tide v2

A focused agentic code editor and orchestrator. Tide drives the coding harnesses you already pay for — **Claude Code, Codex, OpenCode, Pi** — from one place: many threads per repo, each on its own git worktree, each on any harness, with checkpoints, diffs, a real editor and terminal, and cross-harness Experts brainstorming. Server-centric and remote-ready.

Architecture (T3-Code style): a TypeScript `tide-server` owns everything (event-sourced orchestration, provider drivers, git, terminals, files); clients are thin — a browser app and a Tauri desktop shell that supervises the bundled server.

```
apps/server          tide-server: WS/HTTP · event store · decider/projector · drivers · vcs · files · pty · experts
apps/web             React 19 + Vite client (browser and Tauri WebView)
apps/desktop         Tauri v2 shell supervising the bun-compiled server sidecar
packages/contracts   TypeBox schemas: commands, events, read model, RPC table, driver SPI — single source of truth
packages/client      WebSocket client + projection store shared by web/mobile
packages/driver-*    claude (Agent SDK) · codex (app-server) · opencode (serve + SDK) · pi (rpc + tide-bridge)
packages/tide-mcp    MCP server attached to every session: experts board tools + cross-harness tide_delegate
```

What it does today: many threads per repo on any harness, each on its own git worktree;
per-turn checkpoints with diff / revert / commit+PR; harness-native plan mode surfaced as a
ProposedPlan you implement in a sibling thread (on any provider); a real Monaco editor, file
tree, search and terminal bound to the thread's worktree; Mission Control + Inbox for
approvals across all threads; cross-harness Experts panels; agents delegating tasks to other
harnesses; "Open in terminal" escape hatches everywhere. See `docs/internals/overview.md`
and `docs/design/ui.md`.

Several machines: `tide-server serve` on another Mac, Linux box or Windows PC; machines on the
LAN find each other, pair with a 6-digit code (each device gets its own revocable token), and one
repository checked out on several of them shows as one project. `tide service` keeps a server
running; `tide backup` / `tide restore` move the history. Transport on the LAN is plain HTTP and
a paired device has a shell on the machine: pair only what you trust. Details:
[`docs/internals/remote.md`](docs/internals/remote.md).

New here? Start with [`QUICKSTART.md`](QUICKSTART.md); what Tide does to a repo is in [`docs/TRIAL.md`](docs/TRIAL.md).
Running several harnesses on one task (plan → build → review, delegation, teams): [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md).

## Dev

```sh
nvm use            # node 22
pnpm install
pnpm dev           # server on :3777 (prints dev token) + web on :5173
pnpm test && pnpm typecheck
pnpm desktop:sidecar && pnpm desktop:dev   # Tauri shell with the compiled server
```

Provider CLIs are yours: install and log in with `claude`, `codex login`, `opencode auth login`,
`pi`. Tide never reads or stores the harnesses' own logins. What it does keep, in
`~/.tide/settings.json` (mode 0600): keys you enter yourself (the Decisions API key, a relay key,
environment variables of a provider instance). Checks: `pnpm test && pnpm typecheck`, and
`pnpm e2e` for the browser smoke test (local only). Progress log: `JOURNAL.html`.
