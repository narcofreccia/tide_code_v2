# Provider drivers — harness facts (verified 2026-10-12)

Present tense, kept in sync with the code. Tide never re-implements login; each driver
runs the user's installed CLI/SDK and their subscription.

## Common mapping

| Tide `RuntimeMode`     | Claude `permissionMode` | Codex `approvalPolicy` / `sandboxPolicy`     | OpenCode permission | Pi | ACP |
|------------------------|-------------------------|----------------------------------------------|---------------------|----|-----|
| approval-required      | `default`               | `untrusted` / workspace-write                | ask                 | `tool_call` hook → ask | per agent, see [ACP agents](#acp-agents) |
| auto-accept-edits      | `acceptEdits`           | `on-request` / workspace-write               | edits allow, bash ask | hook: writes allow | per agent, see [ACP agents](#acp-agents) |
| auto                   | `auto` (classifier)     | `never` / workspace-write (sandboxed)        | allow               | hook: allow | per agent, see [ACP agents](#acp-agents) |
| full-access            | `bypassPermissions` (+`allowDangerouslySkipPermissions`) | `never` / `dangerFullAccess` | allow | hook: allow | per agent, see [ACP agents](#acp-agents) |

`InteractionMode.plan` → Claude `permissionMode: "plan"`; Codex `collaborationMode`/plan;
OpenCode `plan` agent; Pi = system-prompt + `tide_propose_plan` tool, and in plan mode shell
commands go through a parsed read-only policy (`readonly-shell.ts`) instead of a regex allowlist.

### Instances

The registry (`apps/server/src/provider/registry.ts`) holds one entry per **instance**, keyed by
instance id; threads point at one with `Thread.providerId` (absent = the kind's default).

- **Bundled defaults** — `claude`, `codex`, `opencode`, `pi`: id = kind, labels "Claude Code",
  "Codex", "OpenCode", "Pi", config from `server.json → providers.<kind>`. Always listed, never
  stored in settings; a settings id equal to a kind is refused (`settings.ts`) and ignored by the registry.
- **User instances** — `settings.providerInstances` (`ProviderInstanceConfig`), mapped by
  `provider/instances.ts`. A bundled kind reuses its driver: `server.json` config, then
  `binaryPath`, then `env`, with `home` (`~` expanded) mapped to the harness's own account location:

  | kind | `home` becomes |
  |---|---|
  | claude | `CLAUDE_CONFIG_DIR` |
  | codex | `CODEX_HOME` (and `codexHome` in the driver config) |
  | opencode, pi | `HOME` |

  The driver also gets `DriverEnv.instance {id, label, home?, env}`. Kind `acp` runs the ACP
  driver with a manual `command`/`args`, or with the registry agent's launch
  (`acpAgentId`, `provider/acpRegistry.ts`): npx → `npx -y <package> …args`, uvx →
  `uvx <package> …args`. Binary-only agents are not downloaded; they are listed with
  distribution `binary` and need a manual command. An agent Tide cannot launch is listed as
  not installed with a hint instead of failing the list.
- **Sync** — `settings.set` with `providerInstances` calls `registry.syncInstances`: new ids are
  added, an instance whose config changed is replaced, a dropped one removed. A replaced or
  removed instance that still serves a live session is not disposed; `SessionDirectory.close`
  sweeps it once its last session is gone.
- **Listing** — `providers.list` returns one DTO per instance (`id`, `kind`, `label`): the four
  defaults first in that order, then user instances in settings order.
- **Switching instance** (`thread.update {providerId}`, or `{provider}` = that kind's default)
  behaves like a provider switch: refused while the thread runs, the native session is cleared
  (another account cannot resume it), the model and effort are cleared unless the command names
  new ones, and the history goes to the target as a handoff — `delta` with its own session
  restored when the target already ran the thread, `full` otherwise. Between two instances of
  the same kind it is always `full`, because the projector still keys `providerSessions` by kind.
  An unknown `providerId` is refused (`invalid-command`).
- **Effort** — `thread.create/update {effort}` sets the reasoning level (`""` clears it); it reaches
  the driver as `OpenSessionOptions.effort` and, on a live session, through `reconfigure`.
- **Commands** — `providers.commands {threadId}` asks the thread's instance `listCommands({cwd})`
  (worktree, else project root), cached 30 s per instance + cwd; a `commands` event from a live
  session replaces that entry and does not expire.

### Reconfigure between turns

When a thread's model, runtime mode or interaction changes, the server calls
`ProviderSession.reconfigure(settings)` before the next turn. `applied` means the harness
switched in place; `reopen` means the server closes the session and opens a new one with
`resume` (lossless — the harness's own session id carries the transcript).

| | result | why |
|---|---|---|
| Claude | `applied` | the Query control plane switches live: `setPermissionMode(mode)` + `setModel(model)`. Before the first turn there is no Query yet, so the new values just go into the next `query()` options. A control request the installed CLI rejects (missing method, or it throws) degrades to `reopen`. |
| Codex | `applied` | `turn/start` carries `model`, `approvalPolicy`, `sandboxPolicy` and `collaborationMode` **per turn**; the session stores the new settings and the next turn sends them. |
| OpenCode | `applied` | OpenCode 2: model, agent and the session permission ruleset change in place on a live session (`PATCH /session/:id`, verified with `GET /session/:id`); any failure answers `reopen`. A resumed session gets the thread's current settings re-applied when it opens. |
| Pi | `applied` | the model goes through pi's `set_model` RPC; mode and plan-mode changes go through the bridge command `/tide-config`, sent as a prompt (pi runs extension commands without a model call and answers `handled`). `reopen` only when `get_commands` does not list `/tide-config` or the model id is unknown. |

### Reasoning

Extended thinking is surfaced as `assistant.reasoning` and **shares its `messageKey` with the
text that follows**, so the thinking and the answer render as one message.

| | source | message key |
|---|---|---|
| Claude | `content_block_delta` / `thinking_delta` (and whole `thinking` blocks when partial messages are off) | the *message* id (`message_start.message.id`), never the block index — thinking and text are different blocks of one message |
| Codex | `item/reasoning/textDelta` + `summaryTextDelta` | `<turnId>#<slot>`: reasoning is written to the turn's open message slot, the next `agentMessage` claims that slot, and a completed message opens the next one. Codex reasoning and the message it precedes are separate *items*, so the item id cannot be the key; the slot keeps two agent messages of one turn apart while still merging each with its own reasoning. |
| OpenCode | `reasoning` parts of the assistant message | `assistantMessageID` of the v2 event, so reasoning and text of one message share a key |
| Pi | `thinking_delta` deltas | the per-message key (`pi-<n>`, bumped on `message_start`), with the `contentIndex` dropped so thinking and text merge |

### Reasoning effort (R8)

`ModelInfo.efforts` comes from the harness, per model; `OpenSessionOptions.effort` /
`SessionSettings.effort` carry the pick. `caps.effort` says the driver honours it.

| | levels from | applied at open | live change (`reconfigure`) |
|---|---|---|---|
| Claude | `supportedModels()[].supportedEffortLevels` (omitted when `supportsEffort === false`): `low medium high xhigh max` | `Options.effort` | `Query.applyFlagSettings({effortLevel})` (`null` clears to the model default); no such method on the query → `reopen` |
| Codex | `model/list` → `supportedReasoningEfforts[].reasoningEffort`, `defaultReasoningEffort` flagged `default` | `turn/start.effort` and `collaborationMode.settings.reasoning_effort` on every turn (`null` when unset) | stored, next turn carries it (always `applied`) |
| OpenCode | `GET /api/model` → `variants[].id` (`caps.effort` only when some model has variants) | `ModelRef.variant` on `POST /api/session` / `…/model` (variants live on the model ref; an effort on an unpinned thread pins the server's default model) | `POST /api/session/:id/model` with the same model + new `variant` (cleared effort re-sends it without) |
| ACP | `configOptions` `category: "thought_level"` options, on every model | `session/set_config_option {configId, value}` after `session/new` | same call (`applied`) |
| Pi | `get_available_thinking_levels` of the status process, applied to every model with `reasoning !== false` (pi clamps a level a model lacks): `off minimal low medium high …` | `--thinking <level>` at spawn | `set_thinking_level {level}`; clearing → `reopen` (a fresh process without `--thinking`) |

Unverified without a live login: Pi (no login on the dev machine), so its levels are doc-verified
only (`docs/rpc-commands.md` 1.1.0). Claude's effort list was probed live; OpenCode's variants were
read from a live 2.0.29 server and a session was created with `variant: "low"`.

### Slash commands & skills (R8)

`ProviderInstance.listCommands({cwd})` feeds the composer's `/` picker (`caps.commands`).
Executing is per harness; a leading `/name` that the harness does not list is **sent as-is**
(pass-through), never swallowed.

| | listed from | `source` | executes |
|---|---|---|---|
| Claude | `Query.supportedCommands()` on an idle control query in `cwd` (~1 s). One merged list: Claude's own `builtin: true` rows -> `builtin`; user/project/plugin/MCP commands **and skills** -> `custom` (the SDK does not mark skills in this list; the `system/init` `skills` array only exists after a turn starts) | `builtin` / `custom` | plain prompt text `/name args` — the CLI resolves it |
| Codex | `skills/list {cwds:[cwd]}` on a short-lived app-server; enabled skills only. The 0.162 bindings have **no custom-prompt listing**, so `~/.codex/prompts` are not offered | `skill` | a leading `/<listed skill>` becomes `UserInput {type:"skill", name, path}` + the remaining text as a `text` part (skills are resolved once per session via `skills/list`); unlisted `/x` is plain text |
| OpenCode | `GET /api/command` (custom commands) + `GET /api/skill` (incl. the built-in `opencode` skill), each `[]` on failure | `custom` / `skill` | a listed command -> `POST /api/session/:id/command {name, text: args}` (instead of a prompt; 204, no message id); a listed skill -> `POST …/prompt` with `skills: [{id, mention}]` and the text unchanged; anything else a normal prompt |
| ACP | the latest `available_commands_update` of any session of the instance (none before the first session) | `custom` | plain prompt text `/name args` — the agent resolves it |
| Pi | `get_commands` on a short-lived `pi --mode rpc --no-session` rooted at `cwd`; Tide's own `/tide-config` is hidden | extension/prompt -> `custom`, `skill:` names -> `skill` | `prompt {message: "/name args"}` — pi resolves it (`disposition: "handled"` for extension commands) |

### Unknown events pass through

Per CLAUDE.md §1a a harness event Tide does not model is **rendered generically, not
dropped**: it becomes an `info` activity `"<provider>: <event type>"` carrying the raw frame
in `InfoActivity.payload` (JSON-truncated at ~4 KB). Each driver keeps a short, explicit
allowlist of frames that are dropped silently, because they are content-free housekeeping or
pure duplication of something Tide already renders:

- **Claude** — `system/status`, `system/thinking_tokens`, `command_lifecycle`; a nominal (`status: "allowed"`)
  `rate_limit_event` yields a `usage.rateLimit` gauge update but no timeline row. `SDKTaskStarted/Updated/Progress` are modelled as child-activity
  progress keyed by the spawning `tool_use_id` (so a foreground `Task` and its task frames
  land on one row); the CLI's own `ambient` / `skip_transcript` tasks stay hidden.
- **Codex** — `thread/status/changed`, `thread/settings/updated`, `serverRequest/resolved`,
  `turn/diff/updated`, `remoteControl/status/changed` (`CODEX_SILENT_NOTIFICATIONS`).
- **OpenCode** — see the OpenCode 2 section (`SILENT_EVENTS` lists the v2 housekeeping frames:
  execution/step started, text/reasoning started/ended, tool input events, `usage.updated`,
  `session.status`/`idle`/`renamed`/`viewed`, replies to Tide's own asks). `session.revert.*`
  and `worktree.*` pass through as info rows.
- **Pi** — `agent_start`, `agent_end`, `turn_start`, `turn_end`, `queue_update`,
  `tool_execution_update`, `bash_execution_update` (`PI_SILENT_EVENTS`); the last two are
  per-output-chunk streaming frames whose content arrives whole on `tool_execution_end`.
  `builtin:` tool-name prefixes are stripped, and MCP tools render as `server/tool`.

`unknownCount` now counts every frame that took the pass-through path (known-but-unmodelled
as well as genuinely new), not only unrecognised types.

**Login.** Each driver reports `ProviderStatus.loginCommand` — the exact shell command the UI
offers to run — whenever the CLI is installed but signed out; the install case fills `hint`
only. Claude `claude auth login`, Codex `codex login`, OpenCode `opencode auth login`, Pi `pi`
(pi has no non-interactive login: the user signs in with `/login` once it is up, which the
prose `hint` says). Pi is detected by probing `--version` on the configured path, then the
workspace `node_modules/.bin/pi`, then PATH; a binary that crashes the probe is skipped.

**Process death.** Every driver treats the loss of its child as a settled turn: the live
mailbox gets `{settled, status: interrupted|error}` naming the exit code, and closes. Failing
the harness's in-flight requests is *not* enough — by the time a turn is streaming, the call
that started it has already resolved, so a dead child would otherwise leave the thread
"running" forever. Drivers that own a process also escalate `SIGTERM` → `SIGKILL` after ~5s
on close (OpenCode: see its section).

## Claude Code — `@anthropic-ai/claude-agent-sdk` (0.3.296, CLI 2.1.296; fixtures re-recorded on it)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` → `AsyncGenerator<SDKMessage>` + `interrupt()`, `setPermissionMode()`, `setModel()`.
- Options we use: `cwd`, `model`, `permissionMode`, `canUseTool`, `resume` (session id from `system/init`), `mcpServers: Record<name, {type:'stdio', command, args, env}>`, `strictMcpConfig`, `systemPrompt: {type:'preset', preset:'claude_code', append}`, `includePartialMessages: true` (token streaming), `abortController`, `settingSources` (default all → user/project settings + skills apply), `env`, `stderr`.
- **`systemPrompt` is always sent as `{type:'preset', preset:'claude_code'}`**, with `append` only when Tide has a preamble. An *omitted* `systemPrompt` is an empty **custom** prompt to the SDK (`sdk.d.ts`: a preset object is the opt-in for Claude Code's own prompt), so leaving it out when there is nothing to append silently strips the harness's system prompt.
- `canUseTool(toolName, input, { signal, suggestions, toolUseID, ... })` → `{behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message, interrupt?}`. Only called when no rule/mode auto-approved. `AskUserQuestion` always reaches it → map to `user-input.requested`. `ExitPlanMode` reaches it in plan mode → its `input.plan` (markdown) is the **ProposedPlan**; deny with a message to keep planning, allow = accept plan (we still never auto-implement; implementation is a new thread).
- **"Accept for session / always" is as narrow as the CLI proposes.** `canUseTool` options carry `suggestions: PermissionUpdate[]` (e.g. `addRules` with `Bash(git status:*)`, or `addDirectories`). `approvals.ts` re-targets the `allow`-rule and directory suggestions to `destination: "session"` (accept for session) or `"localSettings"` (accept always) and drops `setMode`/deny updates (Tide owns the mode); with no usable suggestion it falls back to a whole-tool rule. `options.mcpServer {name, source}` (MCP tools) is appended to the approval title.
- **`permissionMode` is always sent.** `sdk.d.ts` documents that an omitted `permissionMode` follows the user's `permissions.defaultMode` (else `auto`), but a Tide thread in `approval-required` must mean manual approvals, so `default` is sent explicitly; a user whose settings default to something wider is therefore narrowed by the thread's mode, never widened. Not adopted deliberately.
- **Steer / fork / rollback** (R4; `caps.steer|fork|rollback = true`; verified against `sdk.d.ts` 0.3.296, not yet live):

  | Cap | Native call | Notes |
  |---|---|---|
  | steer | push an `SDKUserMessage` (own `uuid`) into the streaming-input prompt of the live `query()` | The CLI queues it and folds it into the running turn between tool rounds; tools are not interrupted. `result.user_message_uuids` (d.ts l.5769/5808) lists every uuid the turn consumed. A Tide turn ends on the first `result` **unless** a steer is unconsumed and `result.queued_turn_count > 0` (l.5755/5859): the steer then runs as the CLI's next turn and Tide keeps streaming until that `result`, so `send()` settles once. If an interrupt leaves a steer queued, the query is torn down so it cannot leak into the next `send()` (the next turn resumes the transcript). Older CLIs without those fields: the first `result` ends the turn. `priority` is left unset (CLI default). |
  | fork | `Options.forkSession: true` + `resume: <source>` (l.1714) | New session id arrives on the fork's `system/init`; `nativeSessionId` is unset until then. Not used: the `forkSession()` function (copies the file without a running query). |
  | rollback | `Options.resume` + `resumeSessionAt: <uuid>` (l.2106) on a fresh `query()`; uuid from `getSessionMessages(id, {dir: cwd, includeSystemMessages: true})` (l.906) | The live query is closed and the next `send()` reopens truncated at the kept turn's last chain entry. A turn is what the server counts: every `send()` and every harness turn the server recorded (R14, below); steers never start one. Turn starts (`SessionLedger` in `rollback.ts`) are this session's own prompt uuids (the CLI keeps client uuids in the transcript) plus, per harness turn, the uuid of its first main-chain `user`/`assistant` message as streamed (the `<task-notification>` entry, or Claude's own first entry; an assistant-entry start also takes the unknown, un-steered prompt-like `user` entries right before it; fake-SDK tests only: that the streamed `uuid` is the transcript entry's is assumed, not live-verified). A harness turn takes its slot when it opens, so the order is the order turns ran. A recorded start missing from the transcript (a send that failed before the CLI wrote its prompt, a harness turn that wrote nothing) is an empty turn just before the next start, as the server counts it. A harness turn the server dismisses (`HarnessTurnHandle.dismiss`: request refused, dequeued, thread gone) is not a turn: its entries stay with the turn before. Starts of rolled-back turns are dropped. For older history (resume/fork; the ledger lives only as long as the session object, so any reopen) any human-looking `user` entry counts: a `<task-notification>` that woke the model counts as it should, while a message steered into one of *those* turns, a notification folded into a running turn, a harness turn that opened with Claude's own text, or a compaction summary is miscounted. Dropping every turn starts a brand-new session. Works on an unstarted fork (reads the source's transcript). `resumeDropsTurn` is not sent (it validates exactly one dropped turn). |
- Messages: `system/init` (session_id, model, tools, mcp_servers status), `assistant` (`message.content` blocks: text / tool_use / thinking; `parent_tool_use_id` non-null ⇒ inside a subagent; `subagent_type`, `task_description`), `user` (tool_result blocks), `stream_event` (`BetaRawMessageStreamEvent` deltas when partial messages on), `result` (`subtype success|error`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `permission_denials`, `resume_reason`, `startup_failure_reason` — the last two surface as info rows), `system/compact_boundary`, `system/permission_denied`, `SDKTaskStarted/Updated/Progress` (background tasks / subagents), `SDKRateLimitEvent`.
- **Usage is a per-turn delta.** `result.usage` and `total_cost_usd` are cumulative for the session's one `query()`; `ClaudeNormalizer` keeps the last reported totals and emits only the difference (a counter that goes backwards, i.e. a fresh query, restarts from zero). Context occupancy comes from `getContextUsage()` after each settled turn.
- **Rate limits:** `rate_limit_event.rate_limit_info {status: allowed|allowed_warning|rejected, rateLimitType, resetsAt (epoch s), isUsingOverage|overageInUse, utilization?}` → `usage.rateLimit {status ok|warning|limited, remainingPct, resetsAt (ms), overage}`. CLI 2.1.296 puts utilization (a 0..1 fraction) in an undeclared `unifiedWindows[rateLimitType].utilization`; the top-level `utilization` of the d.ts is read first. Only non-nominal frames also add an info row.
- Plan progress: `TodoWrite` tool_use input `{todos:[{content,status,activeForm}]}`.
- Context usage: control request `get_context_usage`; cost: `get_session_cost`. `result.usage` has `input_tokens`, cache fields.
- **Background sub-agents and harness-initiated turns** (R14; `caps.harnessTurns = true`; seen live on CLI 2.1.316). An `Agent` call that runs in the background returns at once with a placeholder tool_result ("Async agent launched successfully…") and the turn ends with its `result`. Claude Code does not stop there: when the agent finishes, the CLI injects a `user` message whose content string starts with `<task-notification>` (`<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>`, `<summary>`, `<result>`; transcript `origin.kind: "task-notification"`) and runs a new model turn **by itself** on the same `query()`: text, tool calls, even `AskUserQuestion` through `canUseTool`, ending in its own `result`. One notification per agent, so three background agents can mean three autonomous runs. Tide keeps reading the iterator after a send settles (`session.ts` idle loop). Bookkeeping read while idle (session ids, usage, rate limits, child progress, info rows) is held back. The first substantive event (text, a tool call, a child settle, a `<task-notification>` message, or a broker prompt) opens a **harness turn**, handed to `ProviderSession.onHarnessTurn` with a one-line reason (`sub-agent "Audit feature gaps" reported`) and ended by the next `result`. A `send()` that arrives during one waits for it to settle. `hasBackgroundWork()` is true while a backgrounded child has not reported, or while a harness turn is streaming. Before this, those runs sat unread in the iterator and an `AskUserQuestion` from one left the CLI waiting on `canUseTool` forever.
- **Steers during a harness turn** (2026-11-01; fake-SDK tests, not yet live). A harness turn runs on the same streaming-input `query()`, so `steer()` takes it like a steer in a sent turn: the message (own `uuid`) goes straight into the live input, the CLI folds it in between tool rounds, and the harness turn's `result` lists it in `user_message_uuids`. The pending uuids live on the harness turn, so an unconsumed steer with `queued_turn_count > 0` keeps that harness turn streaming until the next `result`, same as in a send. Precedence: a `send()` waiting behind a harness turn is the server's live turn, so it takes the steer (delivered with its prompt); only with no send active does the steer go to the harness turn. Once the harness turn's final `result` is read (while its context usage is fetched, and after it closes) `steer()` throws, and the server's `steer.fallback` queues the message: a steer is refused, never dropped. After an interrupt that leaves a steer queued the query is **not** torn down (unlike a send, where a reset protects the next `send()`): a reset would kill the background sub-agents, and the CLI simply runs the steer next, which the idle loop surfaces as a harness turn of its own. A steer written just as the CLI writes the `result` (not counted in `queued_turn_count`) also runs next and surfaces the same way. Before this, every steer during a harness turn threw "no turn is running" and was silently queued behind it. Each harness turn carries an opaque `key` (`HarnessTurnHandle.key`), and the server's steer names it (`steer(input, { turnKey })`). When the named turn is no longer the live one (the harness finished it and already opened the next while Tide was still streaming it), `steer()` throws `conflict: …` instead of landing the message in the wrong turn. The server then falls back to a queued turn and, because the next harness turn is waiting in Tide behind the old one, promotes that queued turn into it once it runs (`turn.promote`: the message moves into the harness turn that actually folds it in). A fallback that cannot be promoted (images, a handoff) runs as a turn of its own. A steer for a `send()` carries no key and behaves as before.
- **Lost background sub-agents.** A background agent is a task *inside* the CLI process that runs the `query()`; nothing outside it can report for it. When that process ends before the agent's `<task-notification>` arrives, the agent is gone: `claude --resume <id>` (and Tide's own resume on reopen) reloads the transcript, which still holds the "Async agent launched…" placeholder, but no task is restarted and no notification ever follows. So there is no resume-preserving case to wait for. Not live-verified with a kill mid-agent on 2.1.316; inferred from the transport (one process per `query()`, tasks keyed to it) and from `hasBackgroundWork()` being process-local. Tide closes such rows honestly as `error` with the summary "No report: the Claude Code session ended before this sub-agent finished", never `done`: the driver does it when the stream ends or fails (between turns via the idle loop, or under a send) and on any query reset (rollback, interrupted steer), delivering the rows through `onIdleActivity`; the server does it on every `SessionDirectory.close` (explicit close, provider/worktree/settings reopen, interrupt watchdog, idle reaper, shutdown) and in startup recovery (`recoverLostChildren`). While the session lives, children are never touched. The idle reaper keeps a session alive while `hasBackgroundWork()` is true (a driver without the method falls back to the read model's `hasBackgroundChildren`).

## Codex — `codex app-server` (bindings generated from codex-cli 0.162.1; live-verified on 0.147 — 0.162 live run pending a logged-in machine)

- Start `codex app-server` (stdio JSON-RPC 2.0, newline-delimited). Handshake: `initialize {clientInfo}` → response → `initialized` notification.
- `thread/start {model, cwd, approvalPolicy, sandbox: "read-only"|"workspace-write"|"danger-full-access"}` → `thread/started`; `thread/resume {threadId}`; `turn/start {threadId, input:[{type:"text",text}], cwd, model, effort?, approvalPolicy, sandboxPolicy:{type:"workspaceWrite",writableRoots,…}, collaborationMode?}`; `turn/interrupt {threadId, turnId}`.
- **`approvalPolicy` values:** `"untrusted" | "on-request" | {granular:…} | "never"` — there is **no** on-failure policy. A `RuntimeMode` is a *ceiling that may only narrow the user's own `config.toml`* (`modes.ts` `policyFor`; the user's `sandbox_mode`, `approval_policy`, `[sandbox_workspace_write] writable_roots|network_access|exclude_*` are read once per session by `config-toml.ts`). Effective value = the narrower of the mode's level and the user's (an unset key imposes no ceiling):

  | Tide mode | `approvalPolicy` | sandbox |
  |---|---|---|
  | approval-required | `untrusted` (never widened) | `workspace-write`, or `read-only` if the user's `sandbox_mode` is read-only |
  | auto-accept-edits | `on-request`, or the user's if stricter (`untrusted`) | same |
  | auto | `never`, or the user's if stricter (`on-request`/`untrusted`) | same |
  | full-access | the user's `approval_policy` as-is, else `never` | `danger-full-access` — only for an explicitly full-access thread; a user config that allows it does not widen the other modes |

  `writable_roots` are unioned with the thread's cwd + write-linked repos; `network_access` and `exclude_tmpdir_env_var`/`exclude_slash_tmp` carry over. A user `approval_policy = "on-failure"` (not in 0.162's enum) is sent as `on-request`; a `{granular=…}` table is ignored (the mode's level applies). `[profiles.*]` are not read.
- **`collaborationMode` is sent on every `turn/start`**, pinned model or not. Gating it on a pinned model silently dropped plan mode for every thread running the default model; `settings.model` carries the thread's *resolved* model (the one `thread/start` reported), which is what Codex would have used anyway.
- **Sandbox network access is the user's, not Tide's.** `sandboxPolicy.networkAccess` comes from `[sandbox_workspace_write] network_access` in `$CODEX_HOME/config.toml` (default `~/.codex`), read once per session by `config-toml.ts` — a one-key TOML lookup, no dependency. Absent file or absent key ⇒ `false`, which is Codex's own default for a `workspace-write` sandbox. Hardcoding `false` used to take network away from a user whose Codex config grants it (CLAUDE.md §1a). Tide used to *replace* the sandbox/approval policy outright; it now only narrows it (table above).
- **Plan mode:** `turn/start.collaborationMode = {mode:"plan"|"default", settings:{model, reasoning_effort, developer_instructions:null}}` (absent from the ts-rs bindings but parsed strictly by the server; `null` instructions = Codex's native plan prompt). Streaming plan text = `item/plan/delta` → ProposedPlan. Plan/todo progress = `turn/plan/updated` (steps `pending|inProgress|completed`).
- Notifications: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta|patchUpdated`, `item/reasoning/*Delta`, `item/mcpToolCall/progress`, `item/completed` (authoritative), `turn/completed {status: completed|interrupted|failed}`, `thread/tokenUsage/updated {total, last, modelContextWindow}` (`total` = cumulative for the thread, `last` = the request just made), `account/rateLimits/updated {rateLimits: RateLimitSnapshot}`, `model/verification`, `model/rerouted`, `thread/settings/updated`. Unmodelled ones (e.g. `thread/attachment/updated`, `thread/reverted`, `thread/queue/changed`) pass through as info rows.
- **Usage is a per-report delta.** Each `thread/tokenUsage/updated` emits `total − previous total` (per thread; the first report of a thread, and any shrinking counter after compaction, use `last`), so a turn of many model requests sums correctly. `contextUsage.used` = `last.totalTokens` (what the next request carries), not the cumulative total. No cost figure exists in Codex's usage.
- **Rate limits:** `account/rateLimits/updated` and `account/rateLimits/read` (called once per turn, best effort, needs a ChatGPT login) return a `RateLimitSnapshot {primary, secondary: {usedPercent, windowDurationMins, resetsAt}, rateLimitReachedType, spendControlReached}`; the tighter window drives `usage.rateLimit` (`warning` ≥ 90%, `limited` when a reached-type is set or ≥ 100%). `resetsAt` is converted s → ms assuming Codex sends epoch seconds (unverified live).
- 0.162 renamed `thread/rollback` → `thread/revert {threadId, beforeTurnId}` (history only, not files; plus a `thread/reverted` notification). Files stay Tide's: checkpoints revert them via git.
- **Steer / fork / rollback** (R4; `caps.steer|fork|rollback = true`; verified against the 0.162.1 bindings; live on the installed 0.147.0 on 2026-10-15: steer ✔ live, fork ✔ live, rollback via the `thread/rollback` fallback):

  | Cap | Native call (binding) | Notes |
  |---|---|---|
  | steer | `turn/steer {threadId, input: UserInput[], expectedTurnId}` → `{turnId}` (`v2/TurnSteerParams.ts`) | `expectedTurnId` = `turn/started`'s id, else the `turn/start` response's (a steer issued before `turn/start` answers waits for it). Codex refuses a mismatched/finished turn and `review`/`compact` turns (`NonSteerableTurnKind`); the error is surfaced to the caller. `clientUserMessageId` not sent. |
  | fork | `thread/fork {threadId: <source>, cwd, approvalPolicy, sandbox, model?, developerInstructions?, excludeTurns: true}` → `{thread}` (`v2/ThreadForkParams.ts`) | Opens instead of `thread/start`/`thread/resume`; `thread.id` is the new native id. `lastTurnId` not used: the server calls `rollback(n)` after opening. |
  | rollback | `thread/revert {threadId, beforeTurnId}` (`v2/ThreadRevertParams.ts`) | `beforeTurnId` = the oldest dropped turn. Ids come from each `turn/start` response; when `n` reaches past this process's turns (resumed or forked thread), `thread/turns/list {sortDirection: "desc"}` supplies the n-th latest — that list may include non-Tide turns (e.g. compaction). **0.147 fallback:** 0.147 has no `thread/revert` (answers `Invalid request: unknown variant`); the driver then sends the older `thread/rollback {threadId, numTurns}` → `{thread}` (hand-written type in `src/types.ts`, not generated) and remembers it for the session. `thread/revert` is from the 0.162 bindings, not yet seen live. |
- Server→client requests (must be answered or the turn hangs): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `accept|acceptForSession|decline|cancel` (no persistent grant; `acceptAlways` ⇒ `acceptForSession`); `item/permissions/requestApproval` → `{permissions, scope}` (decline = empty grant); `item/tool/requestUserInput` → `{answers:{[questionId]:{answers:string[]}}}` by option label; `mcpServer/elicitation/request` (form mode, incl. the `openai/form` variants if a server sends them) → a `UserInputActivity` built from the requested schema's top-level string / number / boolean / enum / multi-select properties, answered with `{action:"accept", content}` by `respondUserInput` (no answer ⇒ `cancel`); URL-mode elicitations and schemas with nothing renderable stay an accept/decline approval card. Everything else Tide does not model is declined *in kind* and leaves an info row (`codex: <method> (declined, not handled by Tide)`): `item/tool/call` → `{success:false}`, legacy `applyPatchApproval`/`execCommandApproval` → `{decision:{denied:{rejection}}}`, `attestation/generate`, `account/chatgptAuthTokens/refresh` and unknown methods → JSON-RPC `-32601`. (`openai/userVerification` named in the task is not in the 0.162.1 bindings; the nearest, `model/verification`, is rendered as an info row. Tide does not declare the `openai/form` extension at `initialize`.)
- Sub-agents: `collabAgentToolCall` and `subAgentActivity` are **`ThreadItem` variants** (via `item/started|completed`), not notifications → child activities.
- Login probe: `account/read` → `{account|null, requiresOpenaiAuth}`; models: `model/list` (works even signed out). Escape hatch: `codex resume <threadId>`.
- MCP: Tide's servers are added as `-c 'mcp_servers.<name>.command=…'` overrides at spawn — verified to **merge** with the user's own `mcp_servers` (non-crippling).
- **MCP secrets stay off argv.** A stdio MCP server is launched with a small fixed environment (`HOME, LANG, LOGNAME, PATH, SHELL, TERM, TMPDIR, USER`) — the app-server's env is *not* inherited — plus whatever `mcp_servers.<name>.env` sets, which would put the value in `ps`. `mcp_servers.<name>.env_vars = ["NAME", …]` instead names variables to forward **from the app-server's own environment** (verified live against codex-cli 0.147). So Tide spawns `codex app-server` with `TIDE_AGENT_TOKEN` in its env and passes only the variable's *name* on the command line. One process environment holds one value per name, so if two servers want different values for the same variable the second falls back to the visible `…env.NAME=` form and the driver logs it.
- **Lifecycle:** `initialize` carries a 45s deadline (a handshake that never answers would otherwise hang `openSession` forever); child `exit`/`error` settles the running turn with `codex app-server exited (code N)` and closes the mailbox; `close()` sends `SIGTERM` and escalates to `SIGKILL` 5s later.
- **Exact bindings per installed version:** `pnpm --filter @tide/driver-codex regen` (runs `codex app-server generate-ts` and fixes `.ts` specifiers). Regenerate on codex upgrade; never hand-write types.

## OpenCode 2 — HTTP API of the shared service / `opencode serve` (opencode 2.0.27, `@opencode/sdk` 2.0.27 types; verified live 2026-10-12)

OpenCode 2 is a different harness from 1.x: the v1 HTTP/SSE routes (`/session/:id/prompt_async`, `?directory=`, `message.part.updated`, `question.asked`, …) are gone. 1.x is refused.

**Package and binary.** The 2.x CLI is `@opencode/cli` on npm (bins `opencode` and `opencode2`; `opencode-ai` is still 1.x, latest 1.19.0). `opencode --version` prints `opencode v2.0.27` (1.x prints a log line, then `1.1.36`). `@opencode/sdk` 2.x is an **in-process host** ("executes Server's assembled HTTP router in memory, opening no listener"; default database in memory) — running it would be a second OpenCode inside Tide with its own sessions, so the driver uses only its *types* (`OpenCodeEvent`, re-exported from `@opencode/client`) and talks HTTP with `fetch` (`client.ts`). `@opencode/client` (zero-Effect Promise client + `Service.discover`) is the remote client if we ever want the generated surface.

**Where Tide attaches** (`server.ts`), in order:
1. `serverUrl` (+ `serverPassword`) from the provider config;
2. **the user's shared background service** when it is running — the non-crippling default: the same sessions, config, credentials and plugins the user's TUI sees. Discovery mirrors `@opencode/client`'s `Service.discover`: read `$XDG_STATE_HOME/opencode/service.json` (`{id, version, url, pid, password}`), call `GET /api/info` with Basic `opencode:<password>`, trust it only if `pid`/`version` match. Tide never starts the service (`opencode service start` is the user's call; note that `opencode models` etc. auto-start it);
3. else one private `opencode serve --port 0 --hostname 127.0.0.1` per driver instance (`attach: "standalone"` forces this). Tide mints `OPENCODE_SERVER_PASSWORD` (with it set, every route incl. `/api/info` is 401 without Basic auth, and the server prints no password); URL parsed from `server listening on <url>`; SIGTERM, then SIGKILL after 5 s on dispose. The shared service is never killed.
Binary detection prefers a 2.x candidate among `binaryPath` → `~/.opencode/bin/opencode` → every `opencode`/`opencode2` on PATH. A 1.x binary fails with "OpenCode 2.x required, found 1.1.36 — install it with `npm i -g @opencode/cli`". The 1.x upgrader has no `--major` and cannot reach the new package name, so the hint names the npm install directly.x's `upgrade` takes a version: `opencode upgrade 2.0.0`), hence the npm alternative.

**Routes used** (all under `/api`, from `GET /openapi.json` of 2.0.27): `POST /session` `{location:{directory}, title, agent, model:{providerID,id}, permissions, metadata}`; `GET /session/:id` (cumulative `cost`/`tokens`, `agent`, `model`, `permissions`); `PATCH /session/:id {permissions}`; `POST /session/:id/agent {agent}`; `POST /session/:id/model {model}`; `PUT /experimental/session/:id/instructions/entries/:key {value}` (Tide's `systemPromptAppend`, key `tide` — verified the model sees it); `POST /session/:id/prompt {text, files:[{uri,name}]}` (admits, returns at once; `data:` image URIs are accepted and decoded, the model still needs image input); `POST /session/:id/interrupt`; `POST /session/:id/permission/:requestID/reply {decision: once|always|reject}`; `POST /session/:id/form/:formID/reply {answer:{<fieldKey>: value}}`; `GET /event` (SSE); `GET /model`, `GET /model/default`, `GET /agent`, `GET /config` (scoped with `?location[directory]=`, deepObject); `PUT|DELETE /experimental/mcp/:name?location[directory]=`. Sessions carry their own `location.directory`; one server serves every worktree.

**Events.** `GET /api/event` is **server-wide** — no directory/session filter — `data: <json>` frames plus `: heartbeat` comments. The instance holds **one** subscription (`hub.ts`) and routes by `data.sessionID` (or `data.form.sessionID`). A turn is `session.inbox.enqueued/delivered` → `session.execution.started` → per step `session.step.started` (`agent`, `model`) … `session.step.ended` (`finish`, per-step `tokens`/`cost`) → `session.usage.updated` (**cumulative** session totals, incl. title generation which no step reports) → `session.execution.succeeded | failed {error:{type,message}} | interrupted {reason}`. Text/reasoning: `session.{text,reasoning}.{started,delta,ended}` keyed by `assistantMessageID` + `ordinal` → `assistant.delta` / `assistant.reasoning` on messageKey = `assistantMessageID`. Tools: `session.tool.input.started {id,name}` → `session.tool.called {id,input}` → `session.tool.success {content:[{type:"text",text}]}` / `session.tool.failed {error}`; tool names seen: `shell`, `write`, `read`, `question`, `skill`; `subagent` → child row. Usage reported to Tide = last cumulative total − the total when the turn started (resumed sessions start from `GET /session/:id`); reasoning tokens are added to `outputTokens`. Context = last step's `input + cache.read + cache.write + output` over the catalog's `limit.context`.
- Silent (`SILENT_EVENTS`): inbox/execution-started/step-started/streamed, text/reasoning started/ended, tool input events, `tool.progress` (shell ids), `usage.updated` (folded), `session.status`, `session.idle`, `session.renamed`, `session.viewed`, Tide's own `agent.selected`/`model.selected`/`session.permissions`/`metadata.updated`, `permission.replied`, `form.replied`/`cancelled`, compaction started/delta. Everything else naming the session is an info row with the raw payload — including `session.revert.{staged,cleared,committed}` (OpenCode's own snapshot/revert; Tide keeps its own checkpoints and does not translate them). `worktree.updated`/`worktree.resolved` (no session id) are shown when their location is the thread's cwd; the 2.0.27 built-in `worktree_create/list/remove` tools appear as ordinary tool rows.
- Process death: the hub's stream ending fails the running turn (`settled: error`) and invalidates an attached endpoint; the next turn resubscribes (and re-discovers / respawns).

**Permissions** (`permissions.ts`, verified in `@opencode/core` 2.0.27 `permission.ts` and the agent plugins):
- Rule = `{action, resource, effect}`; evaluated over `[...agent.permissions, ...session.permissions]` with `findLast`, default `ask`; a `deny` anywhere blocks before saved rules are read. Agents start from `Agent.Info.default` = `*:* allow` + `.env` read asks, then the user's top-level `permissions` and `agents.<id>.permissions` are appended. Action names: `shell` (v1 `bash`), `edit` (v1 `write`/`patch`), `subagent` (v1 `task`), `read`, `webfetch`, `external_directory`, `question` — the v1 config migration in core maps exactly these.
- Session ruleset Tide sends, in order: **mode rules → link allows → the user's rules, each followed by a copy narrowed by the mode → link denies.** Net effect = the stricter of (user config, thread mode): a user `deny` or blanket `ask` survives `auto`/`full-access`; `approval-required` turns a user `allow` into `ask`; nothing Tide sends ever widens the user's config. (The 1.x driver dropped the user's blanket rules; that is gone.) User rules come from `GET /api/config` documents (never written by Tide); failure to read them logs and falls back to mode rules.

  | Tide mode | rules (action → effect, resource `*`) |
  |---|---|
  | approval-required | `edit`, `shell`, `webfetch` → `ask` |
  | auto-accept-edits | `edit` → `allow`; `shell`, `webfetch` → `ask` |
  | auto | `edit`, `shell`, `webfetch` → `allow` |
  | full-access | `*` → `allow` |
  | any + `interaction: plan` | only the `ask` rules (the `plan` agent's `edit: deny` except `~/.opencode/plan/*` must survive) |
- Approval replies: accept → `once`; **acceptForSession → `once` + an in-memory grant** `{action, save patterns}` that auto-answers later matching asks of that session (emulated: OpenCode's `always` writes a project-wide saved rule, `permission/saved`, that outlives the session); acceptAlways → `always`; decline/cancel → `reject` (core rejects every other pending ask of the session too).
- Linked repos: outside the location a path is asked as `external_directory` (`<abs dir>/*`) then `read`/`edit` with the absolute path; inside, relative. Read + external_directory allows for every link (before the user's rules), edit denies for read-only links last.

**Agents.** `GET /api/agent` lists the user's selected default first (core `Agent.list` = `[selectedDefault, …]`, honouring `default_agent`, skipping hidden/subagent). Tide runs that agent for `interaction: default` (so custom primary agents and `default_agent` work) and `plan` for plan mode; the ProposedPlan is the plan agent's last non-empty text when the execution succeeds. There is no `plan_exit` in 2.x: the plan agent stays until the agent is switched. The agent list is not in `ProviderStatus` (no SPI field for it); `caps.planMode`/`subagents` are derived from it.

**Questions** are forms: the `question` tool emits `form.created {form:{id: frm_…, metadata:{kind:"question", tool}, fields:[{key:"q0", type:"string", description, options:[{value,label}], custom}]}}`; Tide maps fields → user-input questions (id = field key) and answers option labels back as option values.

**Reconfigure → `applied`.** Model (`POST …/model`), agent (`POST …/agent`) and ruleset (`PATCH …/session {permissions}`) all change in place (verified: `GET /session/:id` reflects all three). Any failure answers `reopen`. A resumed session gets the thread's current ruleset/agent/model re-applied at open.

**MCP.** `PUT /api/experimental/mcp/<name>-<threadId>?location[directory]=` `{config:{type:"local", command, environment}}` registers Tide's server for that location at runtime — verified it writes no file into the config dir — and `DELETE` removes it on session close (2.x has a real remove). The user's own MCP servers, plugins and agents are untouched. Tool naming as seen by the model was not re-verified on 2.x.

**Config facts checked** (2.0.27 `Config.Info` in `/openapi.json` and core): `permissions` is the ordered rule array, `agents` (not `agent`), `providers`, `plugins`, `mcp`, `default_agent`, `worktree`, `snapshots`. Instructions: in a scratch HOME a project `CLAUDE.md` alone was **not** picked up while `AGENTS.md` was. Not verified: `prompt→system` rename (an agent's `system` field exists), `mcp.servers` nesting, v1 plugins not running.

- **Steer / fork / rollback** (R4; `caps.steer|fork|rollback = true`; verified against the 2.0.27 packages in `node_modules/.pnpm/@opencode+*@2.0.27*`, not yet live). Paths below are relative to `node_modules/@opencode/<pkg>/dist`:

  | | native call | notes |
  |---|---|---|
  | steer | `POST /api/session/:id/prompt {text, files?, delivery: "steer"}` (protocol `groups/session.js` l.282; client `promise/generated/types.d.ts` l.5615 `readonly delivery?: ("steer" \| "queue") \| null`) | The prompt goes into the session inbox. `steer` items are promoted at the running execution's next step boundary (core `chunks/filesystem-8w54sq4a.js` `promote`), and a wake during an execution loops inside it (`chunks/filesystem-1acjjqhc.js` run-coordinator: `pendingWake` → `loop`, no settle in between). Tools are not interrupted, and the running `send()` ends on that execution's single `session.execution.*`. `steer` is also the server default when `delivery` is omitted (`chunks/filesystem-b6pj8f6d.js` l.56: `request.input.delivery ?? "steer"`), so `send()` keeps omitting it. A steer that arrives just after the execution ended starts a new execution, which Tide does not stream (narrow race). |
  | fork | `POST /api/session/:source/fork {}` → `{data: Session.Info}` (protocol `groups/session.js` l.220; client `SessionForkInput` l.5493 `before?`), then `POST /api/session/:new/move {directory}` (l.272) + `POST /api/experimental/session/:new/wait` (l.380) | With no `before`, the fork copies the whole history; the server then calls `rollback(n)`. Copied messages get **new ids** (core `chunks/filesystem-0jz028se.js` `projectFork`: `${eventId}_${seq}`), and the fork keeps the **source's directory** (`directory: parent.directory`). The copy is therefore moved into the thread's worktree: the move is an inbox item applied by the agent loop without a model call. Tide waits for idle and re-reads `location.directory`. If the move did not land, the fork is deleted (`DELETE /api/session/:id`) and `openSession` fails, because a fork left in the source worktree would edit the wrong checkout. |
  | rollback | `POST /api/session/:id/revert/stage {messageID, files: false}` + `POST /api/session/:id/revert/commit` (protocol `groups/session.js` l.391/410; client `SessionRevertStageInput` l.6177) | `messageID` = the user message that started the oldest dropped turn. Commit deletes every message with `seq >=` it (core `chunks/filesystem-0jz028se.js` l.455). `files: false` leaves the worktree alone (`chunks/filesystem-628cnxdp.js` `stage2`), because Tide's checkpoints own files. Turn starts: the `id` of each `send()`'s prompt response (`SessionInbox.User.id` = the user message id). For history older than the process (resume, fork), `GET /api/session/:id/message` (`groups/message.js` l.55, newest first, `limit` ≤ 200, a cursor must not be combined with `order`) is read: an execution ends with an `idle` message (core `chunks/filesystem-31xfzrxg.js` l.102, `Session.Message.Idle` in `types.d.ts` l.732), so a turn starts at the first `user` message after an `idle`, and steered messages are never counted as turns. A send whose prompt was refused counts as a Tide turn with nothing to drop. The usage baseline is re-read after the cut. A `shutdown` interruption writes no `idle`, so the turns either side of it merge. |
  Not used: `revert.clear` (Tide never leaves a staged revert), `delivery: "queue"` (the server queues Tide turns itself).

**Escape hatch:** `cd <cwd> && opencode --session <id>` (2.x `--help`: "Session ID to continue, or to create if it does not exist"); attaches to the shared service, which reads the same session DB. A configured `binaryPath` is used verbatim since PATH may still hold 1.x. `opencode acp` exists in 2.x (not used).

**Fixtures** (`packages/driver-opencode/test/fixtures/*.ndjson`) are real 2.0.27 recordings with the free `opencode/big-pickle` Zen model (no login) via `scripts/record-fixture.ts`: `basic-turn`, `tool-permission` (shell ask → `once`), `plan-turn`, `question-turn` (form → first option).

## Pi — `pi --mode rpc` (`@earendil-works/pi-coding-agent` 1.1.0, verified 2026-10-12 against a real pi with a scripted model)

Sources: the installed package's `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`,
`docs/rpc-extension-ui.md`, `docs/mcp.md`, `docs/extensions.md`, `CHANGELOG.md` and
`dist/modes/rpc/rpc-types.d.ts`. Fixtures in `packages/driver-pi/test/fixtures/pi/*.ndjson` are
real pi 1.1.0 stdout (`test/record-fixtures.ts`); only the model is a scripted
OpenAI-compatible mock (`test/mock-model.ts`), and `test/real-pi.test.ts` runs the whole driver
against that real pi on every `pnpm test`.

- **Binary**: config `binaryPath` → the workspace's `node_modules/.bin/pi` (pinned 1.1.0) →
  `PATH`. Each candidate must answer `--version` cleanly (a pi that crashes on start is skipped);
  `status().version` is the version it reported. Older than 1.1.0 is accepted with a log line.
- **Transport**: strict LF-delimited JSONL. Commands used: `prompt` (`images`), `abort`,
  `get_state`, `get_session_stats`, `get_commands`, `get_available_models`, `set_model`,
  `extension_ui_response`, `steer`, `fork`, `get_fork_messages`, `get_entries` (R4, below).
  Not used: `follow_up`, `clear_queue`, `clone`, `get_tree`, `switch_session`,
  `set_thinking_level`.
- **`prompt` disposition (0.99)**: `{data:{disposition}}` = `started` | `queued` | `handled`.
  `handled` (an extension command or input handler consumed it) starts no run and emits no
  `agent_settled`, so the turn settles `completed` at once; `started`/`queued` (and a pi that
  sends none) end on `agent_settled`. `success:false` → `settled error`.
- **Events** (`docs/json.md`): `message_update` is delta-only (0.84) — Tide reads
  `text_delta`/`thinking_delta` `delta`s keyed per message (`pi-<n>`, bumped on
  `message_start`). `tool_execution_end` carries `durationMs` (1.1) → the tool activity's
  `durationMs`, and **no `args`** — the driver keeps the start's input. `agent_settled.aborted`
  (1.1) → `interrupted`, even when the run's last assistant message says `stopReason:"error"`
  ("This operation was aborted"), which is what pi actually emits on abort. bash results carry
  `structuredContent {output, truncated, full_output_path}` (0.99); a truncated one gets a
  `(full output: <path>)` line. Silent: `agent_start`, `agent_end`, `turn_start`, `turn_end`,
  `queue_update`, `tool_execution_update`, `bash_execution_update`; `auto_retry_end` only when
  it succeeded. Everything else passes through.
- **Tool names**: built-ins may appear as `builtin:<name>` (0.99, in source info/diagnostics);
  Tide shows the bare name. MCP tools are `mcp__<server>__<tool>` (`-` → `_`); Tide shows
  `server/tool`, as pi's TUI does.
- **Native vs emulated**
  - Native: MCP (core since 0.99), model switching (`set_model`), extension dialogs, sessions
    and resume (`--session <file>`; the file is only written on the first user message since
    0.99, and reopening a not-yet-written path works), context usage (`get_session_stats`).
  - Emulated by tide-bridge: runtime modes (a `tool_call` hook that asks through
    `ctx.ui.confirm`), plan mode (system-prompt instructions + `tide_propose_plan`, plan-mode
    shell allowlist), `systemPromptAppend` (`before_agent_start`). pi has no sub-agents.
- **MCP**: `OpenSessionOptions.mcpServers` → `TIDE_MCP_SERVERS` (JSON) → tide-bridge calls
  `pi.registerMcpServer(name, {command, args, env, exposure:"direct"})` at load
  (`docs/mcp.md` § Add servers from extensions). `direct` because pi's default exposure,
  `codemode`, hides tools from the model unless codemode is on. The user's `~/.pi/agent/mcp.json`
  and `.pi/mcp.json` are never written and `--no-mcp` is never passed; a file-configured server
  with the same name wins over Tide's registration. Caveat: pi interpolates `${NAME}` and a
  leading `!` in `env` values. MCP calls go through the same `tool_call` hook; a tool whose
  server marks it `readOnlyHint` (`pi.getAllTools()` annotations) counts as a read (no approval,
  allowed in plan mode). Other MCP/extension tools are `unknown` (asked in `approval-required` /
  `auto-accept-edits`, never hard-blocked).
- **Dialogs**: every `confirm` is an approval card (`TIDE_META:` first line from tide-bridge;
  a user extension's confirm uses its title/message). `select`/`input`/`editor` from any
  extension → a `user-input` activity with one question (`id: "answer"`, `select` options as
  choices, `input` placeholder / `editor` prefill in the text); `respondUserInput` sends
  `{value}` or `{cancelled:true}` (empty answer, unknown option). Interrupt/close cancels open
  dialogs. `ui_prompt_start`/`ui_prompt_end` are extension-runner events only — they never reach
  RPC stdout, so the `extension_ui_request` itself is the signal. A dialog with `timeout` is
  resolved by pi on expiry; the card then stays pending (no RPC event says it expired).
- **Reconfigure**: model → `set_model {provider, modelId}` (`applied`; a bare pattern or
  unknown model → `reopen`). Mode / plan mode → `prompt "/tide-config {mode, plan}"`, a command
  tide-bridge registers; pi runs extension commands without a model call and answers
  `handled`, nothing reaches the transcript. The bridge then switches its policy and
  activates / withdraws `tide_propose_plan` (`registerTool` / `setActiveTools`). Used only when
  `get_commands` lists `tide-config`; otherwise `reopen`.
- **Plan-mode shell allowlist** (`packages/pi-extensions/src/readonly-shell.ts`): parse-and-deny.
  POSIX tokenizer (quotes respected, so `grep '>'` is fine); split on `| || && ; & newline`;
  refuse `$(…)`, backticks, `<(…)`/`>(…)`, heredocs, and any output redirection except to
  `/dev/null` or fd duplication. Each simple command must be allowlisted *and* free of its
  mutating flags: `sed` (no `-i`/`--in-place`/`-f`, no `w`/`W`/`e` commands or `s///w|e`
  flags), `find` (no `-delete`, `-exec*`, `-ok*`, `-fprint*`, `-fls`), `awk`/`gawk` (no
  `system(`, pipes to/from commands, `print >`, `-f`, `-i inplace`), `env` (only flags /
  `NAME=value`; a trailing command is checked recursively), `git` only `status log diff show
  blame describe ls-files ls-tree rev-parse cat-file shortlog` plus `branch` (list forms only),
  `config` (get/list forms only), `remote` (bare, `-v`, `show`, `get-url`), never `--output`,
  nothing before the subcommand; `sort -o`, `uniq in out`, `rg --pre`, `fd -x`, `tail -f`,
  `tee` and unknown programs are refused. Refusal only blocks in plan mode; outside it the
  normal approval path applies.
- **Usage**: `get_session_stats` `tokens`/`cost` are session totals (they include tool and
  compaction usage) → the driver reports the per-turn delta against the previous snapshot,
  which is what the contract's `usage` wants (verified: turn 2's input is its own requests, not
  the running total). `contextUsage` → `{used, window}`. pi exposes no rate-limit information on
  RPC, so `rateLimit` is never set. tide-bridge's `TIDE_USAGE:` notify is a context-usage
  fallback only.
- **Steer / fork / rollback** (R4; `caps.steer|fork|rollback = true`; verified against
  `node_modules/@earendil-works/pi-coding-agent` 1.1.0 docs and `dist`. An uncommitted
  2026-10-15 run against the real pi 1.1.0 with the scripted model confirmed it: rollback(2)
  then a turn sends only the kept prompts, `--fork` + rollback(1) drops the right turn, a steer
  sent on a tool row reaches the next model request in the same `send()`, and that steered turn
  rolls back as one):

  | | native call | notes |
  |---|---|---|
  | steer | `{"type":"steer", message, images?}` → `{data:{disposition: "queued" \| "handled"}}` (`docs/rpc-commands.md` l.46–68; `dist/modes/rpc/rpc-mode.js` l.319) | Queued into the running agent and delivered after the current tool calls, before the next model call. The running `send()` keeps streaming and ends on its one `agent_settled`. Rejected locally when no turn is running. pi refuses extension commands (`success:false`), which surfaces as a throw. A steer racing the end of a run stays in pi's queue and reaches the next prompt's run. |
  | fork | spawn `pi --mode rpc --fork <source session file>` instead of `--session` (`docs/cli.md` l.94–107; `dist/main.js` `createSessionManager` → `SessionManager.forkFrom`) | pi writes a new session file (new id, header `cwd` = this worktree, `parentSession` = source) with every source entry copied **under the same entry ids**. `nativeSessionId` is the new file from `get_state`. `--fork` wins over a stray `resume` (pi refuses both together). |
  | rollback | `{"type":"fork", entryId}` (`docs/rpc-commands.md` l.610–636; `rpc-mode.js` l.481 → `AgentSessionRuntime.fork`, position `before`) | `entryId` = the user message that started the oldest dropped turn. pi writes a new session file holding the active branch up to *before* that message and switches to it, so `nativeSessionId` moves to the new file (the server reads it at the next turn start). There is no in-place option over RPC: `/tree`'s `navigateTree` is extension/TUI-only, and it only moves an in-memory leaf (`dist/core/session-manager.js` l.1161 `branch()`), which a reopen forgets. Turn starts: after each turn, `get_entries {since: cursor}` (l.689) returns what the turn appended, and its first user message is the prompt. The cursor starts on the last user message from `get_fork_messages` (l.666). Older history (resume, `--fork`) is read with `get_entries` on the active branch: a user message counts as a turn start unless pi was mid-run (previous message a `toolResult`, or an assistant message with `stopReason: "toolUse"`). That heuristic miscounts a steer that lands after the model's final, tool-free answer. Turns recorded by this process are exact. Sends that never ran (`handled`, refused) count as turns with nothing to drop. The fork reloads extensions, so tide-bridge falls back to its spawn env: the driver re-sends `/tide-config` when the mode or plan setting changed live, and re-applies a live `set_model`. `session_before_fork` can cancel the fork (`cancelled: true`), which surfaces as a throw. |

- Not forwarded: project trust. In RPC mode pi skips `.pi/settings.json`, `.pi/mcp.json`,
  `.pi/extensions`, … unless trust is saved for the directory (`~/.pi/agent/trust.json`) or
  `defaultProjectTrust: "always"`; a fresh worktree path has no saved decision
  (`docs/security.md` § Project trust without an interactive prompt). Tide does not answer
  trust on the user's behalf.
- **Lifecycle:** child `exit`/`error` settles the running turn with `pi exited with code N`
  and closes the mailbox; `close()` sends `SIGTERM` then `SIGKILL` 5s later.
- Auth/models are pi's (`~/.pi/agent/{auth,models}.json`); local models via Ollama
  (`:11434/api/tags`) / LM Studio (`:1234/v1/models`). Escape hatch: `pi --session <file>`.

## ACP agents

Agent Client Protocol v1 (`packages/driver-acp`), verified 2026-10-30 against
`@agentclientprotocol/sdk` 2.1.0 `schema/v1` and live OpenCode 2.0.29 / 1.1.36.

One driver for every ACP agent (Gemini CLI, Copilot, Cline, Qwen Code, OpenCode, …), one
`ProviderInstance` per configured agent. The server resolves registry ids to a launch command;
the driver only runs `AcpConfig {command, args?, env?, home?, label?, defaultModel?}`. No SDK
dependency: ndjson JSON-RPC 2.0 over the child's stdio is hand-rolled (`jsonrpc.ts`). stdout is
the protocol (a non-JSON line is logged and skipped), stderr is logged.

- **Process:** one agent process per session (ACP agents serve one client over stdio), spawned
  in the session cwd, in its own process group so `close()` reaches `npx`'s grandchild
  (`SIGTERM`, `SIGKILL` after 5 s). Env: server env → `DriverEnv.instance.env` → `config.env` →
  session env; `home` (config, else instance) becomes `HOME` only when set.
- **Handshake:** `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile, writeTextFile}, terminal: false}, clientInfo: {name: "tide"}}`,
  90 s timeout (first `npx` start downloads the agent). Then `session/new {cwd, mcpServers}`
  (Tide MCP in ACP's stdio shape: `args` always present, `env` as `[{name, value}]`;
  `additionalDirectories` = linked repos when the agent advertises
  `sessionCapabilities.additionalDirectories`), or `session/load {sessionId, cwd, mcpServers}`
  when resuming and `agentCapabilities.loadSession`. `session/load` replays history as
  `session/update`s before replying; the normalizer is muted for it (commands and mode still tracked).
- **Turn:** `session/prompt {sessionId, prompt}` → `{stopReason}`. Text block; images as
  `{type: "image", data, mimeType}` only with `promptCapabilities.image` (else dropped with an
  info row). ACP has no system-prompt field, so `systemPromptAppend` leads the first prompt of a
  new session as a `<tide-context>` text block. `end_turn` → `completed`; `max_tokens` /
  `max_turn_requests` → `completed` + info row; `refusal` → `error`; `cancelled` → `interrupted`.
- **Cancel:** `session/cancel` is a notification; pending `session/request_permission` calls are
  then answered `{outcome: {outcome: "cancelled"}}`. OpenCode 1.1.36 answers the prompt with
  `end_turn` (not `cancelled`) after a cancel (recorded), so the driver settles `interrupted`
  whenever it sent the cancel, whatever the stop reason.
- **Updates:** `agent_message_chunk` → `assistant.delta`, `agent_thought_chunk` →
  `assistant.reasoning` (one key `acp-<turn>#<segment>`, bumped by a tool call after any text or
  reasoning); `tool_call` / `tool_call_update` (merged by `toolCallId`, `content` replaces) →
  `tool` activity (`toolName = name ?? title`, `input = rawInput ?? {title, kind, locations}`,
  `pending|in_progress` → running, `completed` → ok, `failed` → error, output from content
  blocks / diffs / `rawOutput`); `plan` → `plan.progress` (full replace);
  `available_commands_update` → `commands` (`source: "custom"`, `argumentHint = input.hint`;
  outside a turn it is held and delivered at the start of the next one); `current_mode_update`
  → info row; `usage_update {used, size}` → `usage.contextUsage`, and the delta of its
  cumulative `cost` (USD) → the turn's `costUsd`. `PromptResponse.usage` (unstable; OpenCode 2.x
  reports the turn's own tokens there) → the turn's `usage`. `session_info_update`,
  `config_option_update` (ingested as settings), `user_message_chunk` are silent; anything else →
  info row `<sessionUpdate>` with the raw payload.
- **Agent → client requests:** `session/request_permission` → approval card (`requestId` =
  `toolCallId`, diff from the tool's `diff` content), reply held until `respondApproval`:
  `accept` → `allow_once`, `acceptForSession`/`acceptAlways` → `allow_always` (fallback
  `allow_once`), `decline` → `reject_once` (fallback `reject_always`), `cancel` → `cancelled`.
  `fs/read_text_file {path, line?, limit?}` / `fs/write_text_file {path, content}` are served with
  node fs inside the cwd and linked repos only (symlinks resolved first; writes need a `write`
  link); anything else is a JSON-RPC `-32602`. `terminal/*` (Tide advertises `terminal: false`)
  and unknown methods → `-32601`. OpenCode does not use the fs callbacks (it writes itself).

| Tide `RuntimeMode` | permission requests | agent mode picked (best effort, matched on mode id **or** name; never a hardcoded id) |
|---|---|---|
| approval-required | every one → approval card | the agent's initial mode |
| auto-accept-edits | `kind` edit/move/delete/read/search/think/fetch → `allow_once`; execute/other/none → card | `/accept.?edits\|auto.?edit/i` |
| auto | `allow_once` + info row `auto-approved: <title>` | the agent's initial mode |
| full-access | `allow_always` (else `allow_once`) + info row | `/yolo\|bypass\|full\|auto/i` |

The mode selector is a `category: "mode"` config option (`session/set_config_option`) or the
`modes` block (`session/set_mode`). **Plan:** when a mode matches `/plan/i`, `caps.planMode` is on,
`interaction: "plan"` selects it (it wins over the runtime-mode match) and the turn's final
assistant message becomes `plan.proposed`; leaving plan returns to the matched/initial mode.
**Model / effort:** `configOptions` `category: "model"` → `ModelInfo[]` (grouped options
flattened, `currentValue` → default unless `defaultModel` is set), `category: "thought_level"` →
`efforts` on every model (`caps.effort`); both set with `session/set_config_option` after
`session/new` and in `reconfigure` (`applied`; any failed knob → `reopen`). Agents that still
send the pre-configOptions `models {currentModelId, availableModels}` block (OpenCode 1.1.36)
get `session/set_model {sessionId, modelId}`. Nothing reported → `models: []`.

**Status** spawns the agent in `<dataDir>/acp-probe`, runs `initialize` (version = `agentInfo.version`,
caps from `agentCapabilities`), opens **one** throwaway `session/new` there per instance lifetime
to learn models / plan / effort (live sessions refresh them), then kills it; cached 60 s.
ENOENT → `installed: false` + "install it or pick another agent from the registry". An
`auth_required` (`-32000`) answer → `loggedIn: false`, `hint` = the first `authMethods[].description`
(no `authenticate` call in v1); a session that later opens clears it.

`caps`: `{planMode: <plan mode found>, subagents: false, mcp: true, images: promptCapabilities.image, resume: loadSession, contextUsage: false, openInTerminal: false, steer: false, fork: false, rollback: false, oneShot: false, effort: <thought_level found>, commands: true}`.
**Unsupported:** client terminals (`terminal/*`), steer, fork, rollback, sub-agent rows,
one-shot completions, an "open in terminal" command (no portable resume CLI), `authenticate`,
elicitation, and enforcing read-only links for agents that write files themselves.

Live (2026-10-30): OpenCode 2.0.29 `initialize` → `loadSession: true`, `promptCapabilities {image, embeddedContext}`,
`mcpCapabilities {http}`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`;
`session/new` → `configOptions` `model` (8 free models), `effort` (thought_level: low…max, default),
`mode` (build/plan), no `modes`. A pong turn, a read+edit tool turn (no permission requests:
OpenCode's default ruleset allows) and a plan-mode turn ran end to end. OpenCode 1.1.36 answers
legacy `modes` + `models` instead and hangs `session/prompt` silently when the model call fails
(quota), until cancelled.

| registry id | launch |
|---|---|
| gemini | `npx -y @google/gemini-cli@0.66.0 --acp` |
| copilot | `npx -y @github/copilot@1.0.105 --acp` |
| cline | `npx -y cline@3.0.74 --acp` |
| qwen | `npx -y @qwen-code/qwen-code@0.26.4 --acp` |
| opencode | `opencode acp` |

Fixtures: `packages/driver-acp/test/fixtures/{opencode-acp,opencode-acp-1.1}/` recorded with
`node scripts/record.mjs --repo <scratch git repo> [--model id] [--cancel-after ms] -- <agent cmd>`
(client lines carry `"_dir": "c2a"`); `synthetic/` is hand-written (header `synthetic: true`).

## W1 linked repos — how each harness scopes a secondary directory

`OpenSessionOptions.linkedDirs` carries `{path, label, note?, access}`. The preamble reaches
all four through `systemPromptAppend`. Every harness enforces write links natively; the
read-only link is the part each driver has to add.

| | read under a link | write under a write link | write under a read-only link | mechanism |
|---|---|---|---|---|
| Claude | allowed | allowed | denied | `additionalDirectories` (all links — the workspace gate covers reads too) + a `canUseTool` deny on `Edit/Write/MultiEdit/NotebookEdit` targets under a read-only link |
| Codex | allowed | allowed | denied | `sandboxPolicy.writableRoots = [cwd, …write links]`; a `workspace-write` sandbox reads anywhere, so read-only links need no entry |
| OpenCode | allowed | allowed | denied | per-session `permission` ruleset (see below) |
| Pi | allowed | allowed | denied | `tide-bridge` `tool_call` → `{block, reason}`; pi has no sandbox, so write links work with no rule at all |
| ACP | allowed | allowed | denied only through `fs/*` | `session/new.additionalDirectories` (when advertised) + the `fs/*` policy; an agent that writes files itself is not stopped |

- **OpenCode**, verified against 1.1.36's `src/permission/next.ts`: `PermissionNext.evaluate`
  takes the **last** matching rule (`merged.findLast(...)`) and the ruleset is
  `merge(agent.permission, session.permission)`, so Tide's session rules win. `evaluate`'s
  no-match default is `ask`, but in practice it never fires: the agent baseline contains
  `"*": "allow"`, so a rule always matches. `Wildcard.match` compiles `*` to `.*` (it crosses
  `/`), so one `<path>/*` covers a tree. Permission keys include `read`, `edit`, `glob`,
  `grep`, `list`, `bash`, `webfetch`, `websearch`, `codesearch`, `external_directory`,
  `doom_loop`, `question`, `plan_enter`, `plan_exit`. Anything outside the project first hits
  `external_directory`, asked with the **absolute** glob of the target's parent dir — so
  allowing `<link>/*` there is what makes a link reachable at all. `edit` is asked with the
  path **relative to the worktree**, so read-only denies are emitted in both forms.
- **Pi**: `systemPromptAppend` has no RPC equivalent; the driver passes it as
  `TIDE_SYSTEM_PROMPT_APPEND` (plus `TIDE_CWD` / `TIDE_LINKED_DIRS`) and tide-bridge appends
  it in `before_agent_start`, alongside the plan-mode instructions.
- Links always point at the linked repo's real path — a thread in a worktree still reaches
  the link's own checkout. Link paths are stored as `realpath`s (resolved at the RPC
  boundary), and compared with `path.resolve` so trailing slashes and `.`/`..` never matter.
