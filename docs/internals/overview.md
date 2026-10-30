# Architecture overview

Present tense; kept in sync with the code.

## Shape

```
clients ── typed WS RPC ──▶ tide-server ── drivers ──▶ claude · codex · opencode · pi (the user's own CLIs)
 web (browser / Tauri WebView)      │
 tide-mcp (agents' tools)           ├─ event store (SQLite)  decider → events → projector → read model
                                    ├─ vcs: worktrees, checkpoints, diff, restore, publish, merge-back
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
  `resume` is only passed when the thread's last started turn ran on the same provider, or when the
  id is the current harness's own entry in `providerSessions` (switching back resumes it). Every
  `NormalizedEvent` touches the session; the idle reaper (30 min) never closes a session whose
  thread has a turn in flight. Activity identity (`req:`/`tool:` keys) is scoped to the turn.
  On startup, after every reactor has subscribed, a recovery pass settles each turn a previous
  process left `requested`/`running`; a turn queued behind it is promoted by that settle and run.
  `close()` interrupts and settles in-flight turns before the store closes.
  **Steer**: `turn.steered` is forwarded out-of-band to `session.steer()` when the driver reports
  `caps.steer` and that turn is inside `send` on this reactor; otherwise (or when the harness
  refuses) the reactor answers `steer.fallback` and runs the resulting `turn.steer-fell-back`
  turn exactly like a requested one. **Handoff delivery**: a turn carrying `handoffId` is delivered
  natively only on a fork's first turn when the harness can fork and the source's own session on
  that harness ran every surviving source turn (`openSession({ forkFrom })`, then
  `rollback(n)` for the source turns after the fork point); everything else — provider switches,
  full or delta — goes inline as `handoff.text + "---" + "User message:"` ahead of the prompt.
  Either way `handoff.delivered` records how. **Limits**: a `usage` report with
  `rateLimit.status: limited`, or an error matching the usage-limit wording, dispatches
  `thread.limited` after the settle.
- `Scheduler` (`scheduling/`) — every 5 s dispatches `task.fire` for enabled `ScheduledTask`s whose
  `nextRunAt` is due (commandId `scheduled:<task>:<nextRunAt>` so ticks and restarts never double-fire;
  `nextFireAt` is computed from now, so missed fixed slots are skipped and an overdue interval fires once;
  a rejected fire is not retried until `nextRunAt` changes). The decider turns a fire into a turn in the
  task's thread (queued if running) or a new thread. With `continueAfterRestart`, recovery also sends
  "Continue where you left off." to threads whose turn died with the process (max 3 in a row).
- `VcsReactor` — worktree per thread, `before`/`after` checkpoints as `refs/tide/checkpoints/…`
  (the before-snapshot gates the turn; a queued turn is snapshotted when promoted),
  publish (commit/push/`gh pr`, optional `gh pr merge --auto`), merge-back (`vcs/merge.ts`: in a
  scratch worktree `<TIDE_HOME>/worktrees/.merge-<thread>`, then the base ref moves; a clean
  checkout of the base is fast-forwarded, a dirty one is left alone; with an open PR,
  `gh pr merge`), teardown on detach/archive (terminals and watchers first; failures are posted
  as error activities), checkpoint-ref GC on archive. `exclusive(threadId, task)` lets other
  services run git work on a thread's queue.
- `RollbackService` (`orchestration/rollback.ts`) — on `rollback.requested`: checks a file restore
  is safe first (refused in the main checkout or a worktree another live thread shares, by
  realpath), then (a) `session.rollback(n)` with n = rolled-back turns the current harness ran,
  when `caps.rollback` and a live/resumable session exists (a harness without it keeps its memory
  and an info activity says so), (b) with `restoreFiles` the worktree goes back to the first
  rolled-back turn's before-checkpoint (`vcs/restore.ts`; `thread.rollback` is the only rewind), drops the
  rolled-back turns' checkpoint refs, then (c) `rollback.report`. The session stays open: the
  native id may change after a rollback (Pi, Claude) and the next `turn.start` records it.
  Recovery reports a rollback left `rolling` by a dead process as failed.
- `LimitsWorker` (`orchestration/limits.ts`) — every 60 s, a limited thread whose policy is
  `reset` and whose `resetsAt` has passed gets `thread.resume { continue: true }`.
- `SettlementReactor` (`orchestration/settlement.ts`) — on the event that sets `mergedAt` (`pr.updated`
  merged, once per thread even when later syncs repeat the forge's `mergedAt` / `merge.completed`) and every 10 min for threads idle past `inbox.autoSettleAfterDays`, sends
  `thread.settle { reason }`; the decider refuses it for running, waiting, pinned or opted-out threads.
- `PrWatcher` (`vcs/prWatch.ts`) — refreshes a thread's PR through its forge (`vcs/forge/`, GitHub
  via `gh pr view` + `gh api …/pulls/N/comments`) when watching starts, after publish/merge and every
  2 min while `thread.prWatch` is set; reports `pr.update` with checks, check runs, review decision,
  mergeable and the forge's `mergedAt` (a merge seen here settles the thread). At most one
  `turn.request` (notification `pr`) per poll, built by `vcs/prWake.ts`: a check run newly failed
  (named, with the last 40 lines of `gh run view --job N --log-failed`, else its URL), the review
  decision turned `changes_requested` (latest review body), new comments by someone other than the
  viewer (author, `path:line`, body), or a new conflict. CI recovering only posts an info activity.
  Watching stops on merge/close or after 8 consecutive forge failures. Details: `forge.md`.
- PR tab RPCs (`rpc/pr.ts`) — `pr.list/detail/diff/comment/review/merge/link` over the
  `ForgeResolver` (`vcs/forge/resolver.ts`, forge per checkout from `origin`, cached 10 min).
  `server.info.tools.ghAuth` reports `gh auth status`. See `forge.md`.
- `DelegationReactor` (`orchestration/delegation.ts`) — wakes the thread that ran `tide_delegate`.
  When a delegate's last turn settles (completed / interrupted / error) or it goes `limited`, the
  parent gets a `turn.request` (notification `delegate`) quoting the outcome and up to 1500 chars
  of the last reply; settles within 2 s become one message. A pending `user-input` on a delegate is
  relayed at once (notification `child-question`, with the threadId/requestId for
  `tide_pending_respond`) and dequeued again if it is answered before the relay ran. Queued behind
  a running parent, started on an idle one; never for an archived parent, and never for a child
  the parent is blocked on in `agent.thread.wait` (`DelegateWaits`, marked by that handler — the
  wait returns the result itself). Questions are relayed even then. Started after recovery, so
  restart-interrupted delegates do not wake their parents.
- `ExpertsReactor` — delivers each board message as a `turn.request` on its recipients (queued
  behind a running turn, so the backlog lives in the log), tracks expert status.
- `TriageReactor` (`decisions/`) — optional and off by default (`settings.decisions.enabled` plus a
  TypeSafe key). On `turn.settled`, a pending approval/question, `plan.proposed` and a 10-minute
  sweep of silent running threads, it batches one System One request per project (debounced 2 s)
  and dispatches `thread.triage` with calibrated needs-user / stuck / urgency. It only annotates
  threads so the Inbox can sort: it never blocks, routes or acts, and without a key it does nothing.

**Settings in the decider.** The engine reads `limitPolicy`, `worktreeByDefault` and
`providerDefaults` from `SettingsStore` into every `DecideContext` (`DecideDefaults`). A freshly
limited thread takes `limitPolicy` as its `resume` unless the thread already has its own policy;
`thread.delegate` defaults `useWorktree` to `worktreeByDefault` (true) and, like `plan.implement`
and the experts/lead threads, fills a missing model (and, except for experts, which stay `auto`,
the mode) from `providerDefaults[provider]` — a delegate's mode is still clamped to its parent's.
`followUpMode` is stored and served for the clients; the server does not act on it.
**Auto-title**: a `turn.request` on a thread still titled "New thread" (not queued, not a
notification) emits `thread.updated { patch: { title }, autoTitled: true }` before the turn,
from the prompt's first line (markdown markers stripped, ≤ 60 chars on a word boundary + "…").
**Teams** (`team.run`, `decider/team.ts`): creates the lead thread from stage 1 (provider/model/mode
from the stage, else `providerDefaults`; `useWorktree` from the command, else `worktreeByDefault`)
with `thread.team = { name, stages }`, and seeds it with `teamBrief` (`experts/prompts.ts`): the
exact `tide_delegate` call for every later stage (role = stage role, `useWorktree` for `own`,
`inheritWorktreeFrom` for `inherit`, `completion: "wait"`, `timeoutMs` 600000). The server never
runs stages itself; each stage is an ordinary delegate of the lead. An `inherit` stage must name an
earlier stage (default the previous one); stage 1 cannot inherit (`invalid-command`). Saved teams
live in `settings.teams`; while the list is empty `settings.get` returns the presets
(`teams/presets.ts`), and `settings.set { teams: [] }` restores them. Team ids must be unique.
**Inherited worktrees**: `thread.delegate { inheritWorktreeFrom }` (exclusive with `useWorktree` /
`repo`) needs a live thread of the same project with a worktree and branch; the same command emits
`worktree.attached` copied from the source, so the child runs in that checkout from its first turn
with no git work. Checkpoints stay per thread (`refs/tide/checkpoints/<thread>/<turn>/…`); file
restores are refused on a shared checkout (`sharedCheckoutReason`); `thread.merge` / `thread.publish`
from the child are refused with `conflict` while the earliest live thread on that path (the owner)
exists (`inheritedFrom`). On archive/detach the vcs reactor leaves the checkout on disk (and the
workspace keeps its watcher) while another live thread still uses it, and only records
`worktree.detached` for the leaving thread.
**Unarchive**: `thread.unarchive` / `project.unarchive` clear `archivedAt` (idempotent); a thread
needs its project live, a project needs its root path free of another live project. The thread's
worktree is not recreated.

## Domain

Project → Thread (any provider; optional worktree; `role` expert/lead/delegate) → Turn →
Activities (tool, approval, user-input, child, info/error) and Messages, in one
`threadTimeline`. `ProposedPlan` is the output of a plan-mode turn; the only way it runs is
`plan.implement`, which creates a sibling thread on any provider. `ExpertsSession` groups
expert threads with a findings/messages board and a synthesis that becomes a ProposedPlan on
the lead thread. `Thread.attention` (approval / question / plan) is derived by the projector
and drives the Inbox and the ◐ glyph.

## Attachments, ports, icons (R11)

`attachments.upload` writes user files to `<thread cwd>/.tide/attachments/<id>/<name>` (≤ 10 files, ≤ 20 MB
total, no path separators in names) and appends `.tide/` once to the repository's `info/exclude` (for a linked
worktree `git rev-parse --git-path info/exclude` resolves to the common dir; `.gitignore` is never touched).
`turn.request`/`turn.steer` carry the returned refs; the decider keeps `name`/`path` on `Message.attachments`
and the provider reactor appends `Attached files (read them from disk):` + one `- path (mime, size)` line per
file to the prompt only (the stored message text is unchanged). Worktree threads lose their uploads with the
worktree; at server start, `.tide/attachments/<id>` dirs older than 30 days under each project root are removed.
`ports.list` runs `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (fallback `ss -ltnp`) plus `ps -axo pid=,ppid=,comm=`
(cached 3 s) and returns listeners whose process descends from a terminal shell of the thread; harness child
pids are not exposed by `SessionDirectory`, so a server the agent starts itself is found only when it runs in
a Tide terminal. `project.detectIcon` looks for a favicon (≤ 32 KB) in the usual places of the project root.
`tide triage` writes a redacted diagnostics report to `<TIDE_HOME>/triage/<time>.md` (see `remote.md`).

## Providers

`ProviderDriver → ProviderInstance → ProviderSession` (`packages/contracts/src/driver.ts`).
Each driver translates its harness's native protocol into the normalized event vocabulary and
maps Tide's `RuntimeMode` onto the harness's own permission knobs (table in `providers.md`).
Harnesses run with their full native configuration; Tide only adds its MCP server. Every
thread exposes an escape hatch (`claude --resume`, `codex resume`, `opencode -s`, `pi --session`).

The `DriverRegistry` is keyed by **instance**: the four bundled defaults (id = kind) plus the
accounts and ACP agents in `settings.providerInstances`, re-synced on `settings.set`. A thread
names its instance with `providerId`; switching instance hands off like a provider switch.
ACP agents come from the public registry (`provider/acpRegistry.ts`, cached 24 h under the data
dir, bundled snapshot offline). Details: `providers.md` → Instances.

## Agents' tools (tide-mcp)

Every session gets a `tide` MCP server (stdio; `packages/tide-mcp`, or `tide-server --mcp`
inside the compiled sidecar). It connects back over the same WS RPC with a per-thread agent
token; the router grants agent sockets only `agent.*` methods and stamps identity from the
socket. Tools: experts board (`post_finding`, `read_findings`, `send_message`,
`check_messages`, `synthesize`), cross-harness delegation (`tide_delegate`,
`tide_delegate_status`, `inheritWorktreeFrom` to run in another thread's checkout) and thread tools (`agent.thread.list/read/send/wait/interrupt/diff`,
`agent.pending.list/respond`, `rpc/agentThreads.ts`): an agent reaches its own project's threads
and its delegates, never drives a thread whose mode is broader than its own, cannot answer
approvals, `diff` (`rpc/agentDiff.ts`, tool `tide_thread_diff`) returns the same first-checkpoint →
working-tree diff as `vcs.threadDiff` with each patch cut at `maxCharsPerFile` (default 8000) and
binary files without a patch, and `send` in `auto` steers a running turn when the harness can, else queues/starts.
Every session's system prompt append carries the tools hint (`THREAD_TOOLS_HINT`).

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
