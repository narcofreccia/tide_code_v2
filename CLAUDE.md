# CLAUDE.md — Tide v2

Directives for working in this repository. Read before making changes.

> **Standing rule — keep the journal current.** [`JOURNAL.html`](./JOURNAL.html) is the
> living status log. **Read it at the start of every session** and **update it as you
> work** — flip task statuses, add dated notes, log each commit, add/close open questions.
> Treat updating it as part of finishing any task, not an afterthought. Details in §10.

## 1. What this is

Tide v2 is a **focused agentic code editor and orchestrator**: it drives the coding
harnesses the user already pays for — **Claude Code, Codex, OpenCode, Pi** — from one
place. Many threads per repo, each on its own git worktree, each on any harness; per-turn
checkpoints with diff/revert/PR; a real Monaco editor + terminal bound to the thread's
worktree; cross-harness Experts brainstorming; remote-ready. Ground-up rewrite of
`/Users/mac/dev/projects/tide_code` (v1: Tauri + Pi-only, one thread at a time).

**Non-goals (do not add):** Tutor/Learn, voice, model router/classifier, a custom planner,
a custom safety engine, a tree-sitter symbol index or project-memory store (harnesses
already have grep/CLAUDE.md/AGENTS.md — cut by the value test in P5). Planning, sub-agents, workflows and permissions are **harness-native
and surfaced by Tide** — before building a feature, check whether the harness already
provides it and expose that instead. Every new capability must work for all four drivers.

Reference architecture: T3 Code (`pingdotgg/t3code`). Design docs: `docs/design/ui.md`
(layout — thread-first, workbench bound to worktree), `docs/internals/providers.md`
(verified harness facts). The approved plan lives in the user's Claude plans dir.

## 1a. Value test & non-crippling rules (apply to every feature)

For one task in one repo, a terminal harness is already excellent. Tide earns its place
only with what a single terminal harness structurally cannot do: **many threads in one
field of view** (Mission Control + Inbox), **worktree isolation with managed merge-back**,
**uniform turn-level checkpoints/diff/revert across harnesses**, **portability of work
across harnesses/subscriptions**, **a review surface built for agent output + a real
editor**, **cross-harness Experts**, **remote**, **cost/context glass-box**.

Before building anything ask: *does this do something a single harness cannot, or does it
re-do something it already does?* If the latter — cut it or surface the native one.
When unsure how to leverage a harness, look at how T3 Code did it.

Never cripple the harness:
- Run it with **full native power**: user/project settings, `.claude/`/`AGENTS.md`, skills,
  plugins, hooks, the user's MCP servers, subagents, workflows — all on. Tide only *adds*
  its MCP server. A feature that works in the terminal must work in Tide.
- **Escape hatch always available:** every thread offers "Open in terminal"
  (`claude --resume <id>` / `codex resume` / `opencode` in the worktree). Sessions are the
  harness's own; the user can drop to the CLI and come back.
- **Pass through, don't translate, when unsure:** unknown activities/events render
  generically instead of being dropped; native prompts map 1:1 to cards; harness slash
  commands are typeable in the composer.
- **Model lists come from the harness** (`list_models`, Codex manifest, OpenCode catalog),
  never a hardcoded table.

## 2. Stack

- **TypeScript strict, ESM, Node ≥22.13** (`nvm use` → 22; `source ~/.nvm/nvm.sh` in shells).
  Source runs directly: `node --experimental-strip-types` — so **erasable-only TS**: no
  `enum`, no parameter properties, no namespaces; imports carry explicit `.ts`/`.tsx`.
- **pnpm workspaces**, scoped `@tide/*`. `typebox` 1.x for schemas (`Type`/`Static` from
  `typebox`, `Check`/`Errors` from `typebox/value`). **No Effect.** Vitest 4.
- Server: node `http` + `ws`, SQLite via runtime-neutral adapter (`node:sqlite` /
  `bun:sqlite`; **no native deps** — the server is bun-compiled into a sidecar).
- Web: React 19 + Vite + Zustand 5, CSS modules + tokens (no UI kit, no inline style objects).
- Desktop: Tauri v2 shell (later phase) — supervises the server sidecar; ≤ ~800 LOC Rust.

## 3. Layout

```
apps/server        tide-server: rpc/ orchestration/ provider/ vcs/ workspace/ mcp/ experts/
apps/web           React client (browser + Tauri WebView): components/{shell,mission,thread,workbench,experts,settings,ui} state/ lib/
apps/desktop       Tauri shell (P3)
packages/contracts TypeBox: domain, commands, events, pure projector, rpc method table — SINGLE SOURCE OF TRUTH
packages/client    WS connection + projection store + selectors (shared by web / future mobile)
packages/driver-*  one package per harness (claude, codex, opencode, pi)
packages/pi-extensions  the single Pi extension Tide loads (tide-bridge)
packages/tide-mcp  stdio MCP server attached to every session: experts board tools + tide_delegate (cross-harness delegation)
docs/design docs/internals   present-tense design + architecture docs
```

## 4. Architecture rules

- **Server is the only execution boundary.** Provider processes, git, fs, terminals run in
  `apps/server`. Clients talk only over the typed WS RPC in `packages/contracts/src/rpc.ts`.
  `apps/web` must never import Tauri APIs — the browser build is real.
- **Event-sourced orchestration:** client `Command` → pure `decide()` → `DomainEvent[]`
  appended in one SQLite tx → pure `applyEvent()` → read model → published to subscribers.
  One single-writer `Engine`; never mutate the model outside `applyEvent`. Clients reuse the
  same projector from `@tide/contracts` (`applyRecord` is idempotent on `seq`).
- **Contracts first.** Any new command/event/RPC method starts in `packages/contracts`
  (schema + projector + test), then server handler, then client. Payloads are
  self-contained (the projector never looks anything up outside the event).
- **Provider drivers** implement the SPI in contracts (`ProviderDriver` → `ProviderInstance`
  → `ProviderSession`) and translate native protocols into the normalized event vocabulary.
  "Complexity at adapter boundaries, not in orchestration." Drivers hold no business logic.
- **Permissions = harness modes.** One `RuntimeMode` mapped per driver (table in
  `docs/internals/providers.md`). Approvals are activities; decisions are events.
- **Never auto-execute a plan.** A `ProposedPlan` becomes a new thread only on user action.
- Deterministic async: tests await `engine.drain()`, receipts, or promises — **no sleeps/polling**.

## 5. Code standards

- **Every non-doc file ≤ 600–800 LOC.** Split into modules/components/hooks *before*
  crossing it. Exceptions: docs, pure registries/tables, generated protocol bindings.
- **Reuse before writing.** Check `packages/contracts`, `packages/client/selectors`,
  `apps/web/src/components/ui` and existing hooks first. One shared `Button/Pill/Select/
  Menu/Dialog/Kbd`; never re-roll them. Selectors are plain functions, not duplicated in stores.
- Small focused files; comments only where the design isn't obvious; no `any` outside
  declared boundaries (sqlite driver import, generated bindings).
- Stable machine error codes on the wire (`invalid-command`, `not-found`, `conflict`,
  `busy`, `invalid-params`, `method-not-found`, `internal`) — add to the list, don't invent ad hoc.
- UI follows `docs/design/ui.md` (regions, states, keyboard map, tokens). Dark default,
  light via `prefers-color-scheme`. Density: 28px rows, 24px activity lines, 13px base.
- Tests live next to code (`*.test.ts(x)`): decider/projector pure tests, driver normalizers
  on recorded fixtures (`test/fixtures/<provider>/*.ndjson`), component tests with Testing
  Library for anything interactive.

## 6. Run / test

```sh
source ~/.nvm/nvm.sh && nvm use 22
pnpm install
pnpm dev            # server :3777 (prints dev token) + web :5173
pnpm typecheck && pnpm test
```
Server data lives in `TIDE_HOME` (default `~/.tide`; `server.json` holds token + environmentId).
Point `TIDE_HOME` at a scratch dir when experimenting. Dev auth: web reads `?token=` /
`VITE_TIDE_TOKEN`; prod uses `POST /api/auth/ws-ticket` → `?wsTicket=`.

## 7. Provider CLIs (bring-your-own-subscription)

Installed by the user, never bundled (except Pi): `claude` (Agent SDK), `codex`
(`codex app-server`; regenerate bindings with `codex app-server generate-ts` on upgrade),
`opencode` (`opencode serve` + SDK), `pi` (`--mode rpc`). Facts and version notes:
`docs/internals/providers.md` — update it when a protocol detail changes.

## 8. Phases

P0 skeleton + contracts + engine + shell · P1 Claude driver end-to-end (chat, approvals,
plan mode → ProposedPlan, subagent activities) · P2 git worktrees + checkpoints + diff + PR ·
P3 editor + terminal + Tauri shell · P4 Codex/OpenCode/Pi drivers · P5 Tide MCP (experts board + cross-harness delegation) + Experts UI ·
P6 glass-box + polish + remote hardening. Status: `JOURNAL.html`.

## 9. How we work (orchestration)

The main Claude session owns design and validation; implementation is fanned out to
Opus subagents on disjoint directories with a precise spec and a quality bar (typecheck +
tests + boot check). Validate before committing: run the tests yourself, read the core
files, boot the thing. Contracts changes are made by the orchestrator, not by workers.

## 10. Project journal — `JOURNAL.html`

Source of truth for what is done / in progress / open. Status is encoded in markup
(`class="status done|wip|todo|blocked"`) so hand edits stick. On every task: flip the
task's status, add a dated note under its phase, log the commit (phase · date · message ·
short SHA) in "Commit log", add/close "Open questions". The "Notes & priorities" block at
the bottom is the user's space — never rewrite it, only append if asked.

## 11. Git

- Commit when a validated slice lands (the user asked for continuous progress); never push
  unless asked. Remote: `origin` → `github.com/narcofreccia/tide_code_v2`. Work on `main`.
- Messages: conventional prefix (`feat(server):`, `feat(web):`, `docs:`, `chore:`), short body
  on *why*. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never commit secrets: `~/.tide/server.json`, provider auth files, `.env`, `.env.build`.
- **Releases are user-triggered only.** Never run `scripts/release/*`, never tag, never
  trigger the release workflows, never upload to R2 unless the user asks in that turn.
  Runbook, bucket layout and invariants: [`docs/RELEASING.md`](./docs/RELEASING.md).
