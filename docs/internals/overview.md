# Architecture overview

Present tense; kept in sync with the code.

## Shape

```
clients ── typed WS RPC ──▶ tide-server ── drivers ──▶ claude · codex · opencode · pi (the user's own CLIs)
 web (browser / Tauri WebView)      │
 tide-mcp (agents' tools)           ├─ event store (SQLite)  decider → events → projector → read model
                                    ├─ vcs: worktrees, checkpoints, diff, revert, publish
                                    ├─ workspace: files, watcher, search, pty
                                    └─ experts: board, mailbox delivery, synthesis
```

The server (`apps/server`) is the only execution boundary. Every client — the browser app,
the Tauri shell's WebView, and the MCP server the agents talk to — speaks the RPC contract in
`packages/contracts/src/rpc.ts` over one WebSocket. Nothing in `apps/web` imports Tauri.

## Orchestration (event-sourced)

`ClientCommand` (from a UI) or `AgentCommand` (from an agent via tide-mcp) or `InternalCommand`
(from a server reactor) → `decide(model, command)` (pure, `orchestration/decider/*`) →
`DomainEvent[]` appended in one SQLite transaction (`EventStore`) → `applyEvent` (pure,
shared with clients in `packages/contracts/src/projection.ts`) → read model → published to
`model.subscribe` streams. One `Engine` processes commands strictly serially, so the log
order is total and `seq` is the only cursor clients need (reconnect = `fromSeq`).

Reactors subscribe to events and issue further commands; they hold no business rules:
- `ProviderReactor` — `turn.requested` → open/resume a driver session (in the thread's worktree
  cwd) → translate `NormalizedEvent`s into internal commands (`assistant.append`,
  `assistant.reasoning.append`, `activity.upsert`, `plan.propose`, `usage.report`, `turn.settle`).
  Approvals and interrupts are forwarded out-of-band so they never queue behind the running turn.
  A `turn.request` sent while the thread is running is **queued** (`Turn.status: queued`) and
  promoted when the live turn settles; `turn.dequeue` drops it. Before each turn the
  `SessionDirectory` compares the thread's model/mode/interaction with what the session was
  opened with and either calls the driver's `reconfigure()` or reopens the session with `resume`.
  On startup a recovery pass settles every turn a previous process left `queued`/`requested`/
  `running`; `close()` interrupts and settles in-flight turns before the store closes.
- `VcsReactor` — worktree per thread, `before`/`after` checkpoints as `refs/tide/checkpoints/…`
  (the before-snapshot gates the turn), revert, publish (commit/push/`gh pr`), teardown on archive.
- `ExpertsReactor` — delivers board messages as follow-up turns (mailbox per thread), tracks
  expert status.

## Domain

Project → Thread (any provider; optional worktree; `role` expert/lead/delegate) → Turn →
Activities (tool, approval, user-input, child, info/error) and Messages, in one
`threadTimeline`. `ProposedPlan` is the output of a plan-mode turn; the only way it runs is
`plan.implement`, which creates a sibling thread on any provider. `ExpertsSession` groups
expert threads with a findings/messages board and a synthesis that becomes a ProposedPlan on
the lead thread. `Thread.attention` (approval / question / plan) is derived by the projector
and drives the Inbox and the ◐ glyph.

## Providers

`ProviderDriver → ProviderInstance → ProviderSession` (`packages/contracts/src/driver.ts`).
Each driver translates its harness's native protocol into the normalized event vocabulary and
maps Tide's `RuntimeMode` onto the harness's own permission knobs (table in `providers.md`).
Harnesses run with their full native configuration; Tide only adds its MCP server. Every
thread exposes an escape hatch (`claude --resume`, `codex resume`, `opencode -s`, `pi --session`).

## Agents' tools (tide-mcp)

Every session gets a `tide` MCP server (stdio; `packages/tide-mcp`, or `tide-server --mcp`
inside the compiled sidecar). It connects back over the same WS RPC with a per-thread agent
token; the router grants agent sockets only `agent.*` methods and stamps identity from the
socket. Tools: experts board (`post_finding`, `read_findings`, `send_message`,
`check_messages`, `synthesize`) and cross-harness delegation (`tide_delegate`,
`tide_delegate_status`).

## Auth & remote

`~/.tide/server.json` holds `environmentId` + a server token. Browsers get a 5-minute
single-use ticket (`POST /api/auth/ws-ticket` with the bearer token) and connect with
`?wsTicket=`; `--dev` also accepts `?token=`. The Tauri shell supervises the bundled server and
hands the web app `?token&server`. Remote = connection layer only: bind with `--host`, reach it
over Tailscale/SSH; the server never splits.

## Desktop

`apps/desktop` is a thin Tauri v2 shell (~500 LOC Rust): free port, spawn the sidecar with
`TIDE_HOME`, poll `/health`, navigate the WebView, restart with backoff, kill on exit. The
sidecar is `apps/server` compiled with bun (`scripts/build-server-sidecar.sh`); under Bun the
server uses `bun:sqlite` and `Bun.spawn({terminal})` for PTYs, so it has no native deps.
