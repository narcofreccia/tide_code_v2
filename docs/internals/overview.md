# Architecture overview

Present tense; kept in sync with the code.

## Shape

```
clients ── typed WS RPC ──▶ tide-server ── drivers ──▶ claude · codex · opencode · pi (the user's own CLIs)
 web (browser / Tauri WebView)      │
 tide-mcp (agents' tools)           ├─ event store (SQLite)  decider → events → projector → read model
                                    ├─ vcs: worktrees, checkpoints, diff, revert, publish, merge-back
                                    ├─ workspace: files, watcher, search, pty
                                    └─ experts: board, message delivery as turns, synthesis
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
  `resume` is only passed when the thread's last started turn ran on the same provider. Every
  `NormalizedEvent` touches the session; the idle reaper (30 min) never closes a session whose
  thread has a turn in flight. Activity identity (`req:`/`tool:` keys) is scoped to the turn.
  On startup, after every reactor has subscribed, a recovery pass settles each turn a previous
  process left `requested`/`running`; a turn queued behind it is promoted by that settle and run.
  `close()` interrupts and settles in-flight turns before the store closes.
- `VcsReactor` — worktree per thread, `before`/`after` checkpoints as `refs/tide/checkpoints/…`
  (the before-snapshot gates the turn; a queued turn is snapshotted when promoted), revert,
  publish (commit/push/`gh pr`, optional `gh pr merge --auto`), merge-back (`vcs/merge.ts`: in a
  scratch worktree `<TIDE_HOME>/worktrees/.merge-<thread>`, then the base ref moves; a clean
  checkout of the base is fast-forwarded, a dirty one is left alone; with an open PR,
  `gh pr merge`), teardown on detach/archive (terminals and watchers first; failures are posted
  as error activities), checkpoint-ref GC on archive.
- `ExpertsReactor` — delivers each board message as a `turn.request` on its recipients (queued
  behind a running turn, so the backlog lives in the log), tracks expert status.
- `TriageReactor` (`decisions/`) — optional and off by default (`settings.decisions.enabled` plus a
  TypeSafe key). On `turn.settled`, a pending approval/question, `plan.proposed` and a 10-minute
  sweep of silent running threads, it batches one System One request per project (debounced 2 s)
  and dispatches `thread.triage` with calibrated needs-user / stuck / urgency. It only annotates
  threads so the Inbox can sort: it never blocks, routes or acts, and without a key it does nothing.

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
