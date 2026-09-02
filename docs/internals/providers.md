# Provider drivers — harness facts (verified 2026-09-03)

Present tense, kept in sync with the code. Tide never re-implements login; each driver
runs the user's installed CLI/SDK and their subscription.

## Common mapping

| Tide `RuntimeMode`     | Claude `permissionMode` | Codex `approvalPolicy` / `sandboxPolicy`     | OpenCode permission | Pi |
|------------------------|-------------------------|----------------------------------------------|---------------------|----|
| approval-required      | `default`               | `untrusted` / workspace-write                | ask                 | `tool_call` hook → ask |
| auto-accept-edits      | `acceptEdits`           | `on-request` / workspace-write               | edits allow, bash ask | hook: writes allow |
| auto                   | `auto` (classifier)     | `never` / workspace-write (sandboxed)        | allow               | hook: allow |
| full-access            | `bypassPermissions` (+`allowDangerouslySkipPermissions`) | `never` / `dangerFullAccess` | allow | hook: allow |

`InteractionMode.plan` → Claude `permissionMode: "plan"`; Codex `collaborationMode`/plan;
OpenCode `plan` agent; Pi = system-prompt + `tide_propose_plan` tool.

### Reconfigure between turns

When a thread's model, runtime mode or interaction changes, the server calls
`ProviderSession.reconfigure(settings)` before the next turn. `applied` means the harness
switched in place; `reopen` means the server closes the session and opens a new one with
`resume` (lossless — the harness's own session id carries the transcript).

| | result | why |
|---|---|---|
| Claude | `applied` | the Query control plane switches live: `setPermissionMode(mode)` + `setModel(model)`. Before the first turn there is no Query yet, so the new values just go into the next `query()` options. A control request the installed CLI rejects (missing method, or it throws) degrades to `reopen`. |
| Codex | `applied` | `turn/start` carries `model`, `approvalPolicy`, `sandboxPolicy` and `collaborationMode` **per turn**; the session stores the new settings and the next turn sends them. |
| OpenCode | `reopen` | the permission ruleset and the agent (`plan` vs `build`) are fixed at `session.create`, and `PATCH /session` only takes a title. **Caveat:** a reopen that resumes the same native session still runs the creation-time ruleset, so a mode change only really lands on a brand-new opencode session — see the OpenCode section. |
| Pi | `reopen` | mode and interaction reach tide-bridge through the process environment (`TIDE_RUNTIME_MODE`/`TIDE_INTERACTION`) at spawn, and the model through argv. |

### Reasoning

Extended thinking is surfaced as `assistant.reasoning` and **shares its `messageKey` with the
text that follows**, so the thinking and the answer render as one message.

| | source | message key |
|---|---|---|
| Claude | `content_block_delta` / `thinking_delta` (and whole `thinking` blocks when partial messages are off) | the *message* id (`message_start.message.id`), never the block index — thinking and text are different blocks of one message |
| Codex | `item/reasoning/textDelta` + `summaryTextDelta` | `<turnId>#<slot>`: reasoning is written to the turn's open message slot, the next `agentMessage` claims that slot, and a completed message opens the next one. Codex reasoning and the message it precedes are separate *items*, so the item id cannot be the key; the slot keeps two agent messages of one turn apart while still merging each with its own reasoning. |
| OpenCode | `reasoning` parts of the assistant message | the id of the **first streamed reasoning-or-text part** of that message; every later part of the same `messageID` reuses it (reasoning normally arrives first, so the text merges onto it) |
| Pi | `thinking_delta` deltas | the per-message key (`pi-<n>`, bumped on `message_start`), with the `contentIndex` dropped so thinking and text merge |

### Unknown events pass through

Per CLAUDE.md §1a a harness event Tide does not model is **rendered generically, not
dropped**: it becomes an `info` activity `"<provider>: <event type>"` carrying the raw frame
in `InfoActivity.payload` (JSON-truncated at ~4 KB). Each driver keeps a short, explicit
allowlist of frames that are dropped silently, because they are content-free housekeeping or
pure duplication of something Tide already renders:

- **Claude** — `system/status`, `system/thinking_tokens`, and a nominal (`status: "allowed"`)
  `rate_limit_event`. `SDKTaskStarted/Updated/Progress` are modelled as child-activity
  progress keyed by the spawning `tool_use_id` (so a foreground `Task` and its task frames
  land on one row); the CLI's own `ambient` / `skip_transcript` tasks stay hidden.
- **Codex** — `thread/status/changed`, `thread/settings/updated`, `serverRequest/resolved`,
  `turn/diff/updated`, `remoteControl/status/changed` (`CODEX_SILENT_NOTIFICATIONS`).
- **OpenCode** (`SILENT_EVENTS`) — `server.heartbeat`, `file.watcher.updated`,
  `session.updated`, `permission.replied`, `question.replied`, `question.rejected`,
  `file.edited`, `session.diff`, `server.connected`. The last six duplicate rows Tide
  already draws (the approval/user-input cards, the write tool activity, the git-computed
  checkpoint diff) or would fire once per turn. `message.removed` / `message.part.removed`
  are real content changes and still pass through.
- **Pi** — `agent_start`, `agent_end`, `queue_update`, `tool_execution_update`,
  `bash_execution_update` (`PI_SILENT_EVENTS`); the last two are per-output-chunk streaming
  frames whose content arrives whole on `tool_execution_end`.

`unknownCount` now counts every frame that took the pass-through path (known-but-unmodelled
as well as genuinely new), not only unrecognised types.

**Login.** Each driver reports `ProviderStatus.loginCommand` — the exact shell command the UI
offers to run — whenever the CLI is installed but signed out; the install case fills `hint`
only. Claude `claude auth login`, Codex `codex login`, OpenCode `opencode auth login`, Pi `pi`
(pi has no non-interactive login: the user signs in with `/login` once it is up, which the
prose `hint` says).

**Process death.** Every driver treats the loss of its child as a settled turn: the live
mailbox gets `{settled, status: interrupted|error}` naming the exit code, and closes. Failing
the harness's in-flight requests is *not* enough — by the time a turn is streaming, the call
that started it has already resolved, so a dead child would otherwise leave the thread
"running" forever. Drivers that own a process also escalate `SIGTERM` → `SIGKILL` after ~5s
on close.

## Claude Code — `@anthropic-ai/claude-agent-sdk` (0.3.x)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` → `AsyncGenerator<SDKMessage>` + `interrupt()`, `setPermissionMode()`, `setModel()`.
- Options we use: `cwd`, `model`, `permissionMode`, `canUseTool`, `resume` (session id from `system/init`), `forkSession`, `mcpServers: Record<name, {type:'stdio', command, args, env}>`, `strictMcpConfig`, `systemPrompt: {type:'preset', preset:'claude_code', append}`, `includePartialMessages: true` (token streaming), `abortController`, `settingSources` (default all → user/project settings + skills apply), `env`, `stderr`.
- **`systemPrompt` is always sent as `{type:'preset', preset:'claude_code'}`**, with `append` only when Tide has a preamble. An *omitted* `systemPrompt` is an empty **custom** prompt to the SDK (0.3.251 `sdk.d.ts`: a preset object is the opt-in for Claude Code's own prompt), so leaving it out when there is nothing to append silently strips the harness's system prompt.
- `canUseTool(toolName, input, { signal, suggestions, toolUseID, ... })` → `{behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message, interrupt?}`. Only called when no rule/mode auto-approved. `AskUserQuestion` always reaches it → map to `user-input.requested`. `ExitPlanMode` reaches it in plan mode → its `input.plan` (markdown) is the **ProposedPlan**; deny with a message to keep planning, allow = accept plan (we still never auto-implement; implementation is a new thread).
- Messages: `system/init` (session_id, model, tools, mcp_servers status), `assistant` (`message.content` blocks: text / tool_use / thinking; `parent_tool_use_id` non-null ⇒ inside a subagent; `subagent_type`, `task_description`), `user` (tool_result blocks), `stream_event` (`BetaRawMessageStreamEvent` deltas when partial messages on), `result` (`subtype success|error`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `permission_denials`), `system/compact_boundary`, `system/permission_denied`, `SDKTaskStarted/Updated/Progress` (background tasks / subagents), `SDKRateLimitEvent`.
- Plan progress: `TodoWrite` tool_use input `{todos:[{content,status,activeForm}]}`.
- Context usage: control request `get_context_usage`; cost: `get_session_cost`. `result.usage` has `input_tokens`, cache fields.

## Codex — `codex app-server` (codex-cli 0.147, verified against generated bindings + live)

- Start `codex app-server` (stdio JSON-RPC 2.0, newline-delimited). Handshake: `initialize {clientInfo}` → response → `initialized` notification.
- `thread/start {model, cwd, approvalPolicy, sandbox: "read-only"|"workspace-write"|"danger-full-access"}` → `thread/started`; `thread/resume {threadId}`; `turn/start {threadId, input:[{type:"text",text}], cwd, model, effort?, approvalPolicy, sandboxPolicy:{type:"workspaceWrite",writableRoots,…}, collaborationMode?}`; `turn/interrupt {threadId, turnId}`.
- **`approvalPolicy` values:** `"untrusted" | "on-request" | {granular:…} | "never"` — there is **no** on-failure policy. Tide mapping: approval-required → `untrusted`+workspace-write; auto-accept-edits → `on-request`+workspace-write; auto → `never`+workspace-write; full-access → `never`+`dangerFullAccess`.
- **`collaborationMode` is sent on every `turn/start`**, pinned model or not. Gating it on a pinned model silently dropped plan mode for every thread running the default model; `settings.model` carries the thread's *resolved* model (the one `thread/start` reported), which is what Codex would have used anyway.
- **Sandbox network access is the user's, not Tide's.** `sandboxPolicy.networkAccess` comes from `[sandbox_workspace_write] network_access` in `$CODEX_HOME/config.toml` (default `~/.codex`), read once per session by `config-toml.ts` — a one-key TOML lookup, no dependency. Absent file or absent key ⇒ `false`, which is Codex's own default for a `workspace-write` sandbox. Hardcoding `false` used to take network away from a user whose Codex config grants it (CLAUDE.md §1a).
- **Plan mode:** `turn/start.collaborationMode = {mode:"plan"|"default", settings:{model, reasoning_effort, developer_instructions:null}}` (absent from the ts-rs bindings but parsed strictly by the server; `null` instructions = Codex's native plan prompt). Streaming plan text = `item/plan/delta` → ProposedPlan. Plan/todo progress = `turn/plan/updated` (steps `pending|inProgress|completed`).
- Notifications: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta|patchUpdated`, `item/reasoning/*Delta`, `item/mcpToolCall/progress`, `item/completed` (authoritative), `turn/completed {status: completed|interrupted|failed}`, `thread/tokenUsage/updated {total, last, modelContextWindow}` (`last` = turn usage; `total`+window = context gauge), `model/rerouted`, `thread/settings/updated`.
- Server→client requests (must be answered or the turn hangs): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `accept|acceptForSession|decline|cancel` (no persistent grant; `acceptAlways` ⇒ `acceptForSession`); `item/permissions/requestApproval` → `{permissions, scope}` (decline = empty grant); `item/tool/requestUserInput` → `{answers:{[questionId]:{answers:string[]}}}` by option label; also `mcpServer/elicitation/request`, `item/tool/call`, `attestation/generate`, `account/chatgptAuthTokens/refresh`, legacy `applyPatchApproval`/`execCommandApproval`.
- Sub-agents: `collabAgentToolCall` and `subAgentActivity` are **`ThreadItem` variants** (via `item/started|completed`), not notifications → child activities.
- Login probe: `account/read` → `{account|null, requiresOpenaiAuth}`; models: `model/list` (works even signed out). Escape hatch: `codex resume <threadId>`.
- MCP: Tide's servers are added as `-c 'mcp_servers.<name>.command=…'` overrides at spawn — verified to **merge** with the user's own `mcp_servers` (non-crippling).
- **MCP secrets stay off argv.** A stdio MCP server is launched with a small fixed environment (`HOME, LANG, LOGNAME, PATH, SHELL, TERM, TMPDIR, USER`) — the app-server's env is *not* inherited — plus whatever `mcp_servers.<name>.env` sets, which would put the value in `ps`. `mcp_servers.<name>.env_vars = ["NAME", …]` instead names variables to forward **from the app-server's own environment** (verified live against codex-cli 0.147). So Tide spawns `codex app-server` with `TIDE_AGENT_TOKEN` in its env and passes only the variable's *name* on the command line. One process environment holds one value per name, so if two servers want different values for the same variable the second falls back to the visible `…env.NAME=` form and the driver logs it.
- **Lifecycle:** `initialize` carries a 45s deadline (a handshake that never answers would otherwise hang `openSession` forever); child `exit`/`error` settles the running turn with `codex app-server exited (code N)` and closes the mailbox; `close()` sends `SIGTERM` and escalates to `SIGKILL` 5s later.
- **Exact bindings per installed version:** `pnpm --filter @tide/driver-codex regen` (runs `codex app-server generate-ts` and fixes `.ts` specifiers). Regenerate on codex upgrade; never hand-write types.

## OpenCode — `opencode serve` + `@opencode-ai/sdk` (opencode 1.1.36 / sdk 1.18, verified live)

- One managed `opencode serve --port 0 --hostname 127.0.0.1` **per instance** (a server started anywhere runs sessions in whatever `directory` they carry); URL parsed from stdout; `GET /global/health` → `{healthy, version}`.
- **Every route takes `?directory=`, including `event.subscribe`** — without it the SSE stream silently carries no session events.
- SDK methods used: `session.create` (accepts a per-session `permission` ruleset `{permission, pattern, action}[]` — newer than the SDK body type), `session.promptAsync` (returns `{}`; completion only via SSE `session.idle`), `session.abort`, `postSessionIdPermissionsPermissionId` (`once|always|reject`), `event.subscribe`, `config.providers` (models `provider/model`), `app.agents` (`plan`/`build`), `mcp.add`. Raw: `POST /question/{id}/reply {answers: string[][]}`.
- Events: `message.part.updated` (text `delta`, tool parts with state), `message.updated` (assistant `tokens`/`cost`), `permission.asked` (`id, permission, patterns, metadata, tool.{messageID,callID}`), `permission.replied`, `question.asked`, `todo.updated` → plan progress, `session.status` (`busy`/`retry` → info), `session.idle` → settled, `session.error`.
- **The SSE subscription is the session's lifeline and is re-established per turn.** It is the only channel a turn's events arrive on, so when the stream ends — error or clean close — the driver drops its handle and the next `send()` subscribes again. A stream that stayed dead made every later turn hang with a prompt nobody was listening to.
- **MCP registration is per thread: `<name>-<threadId>`.** `POST /mcp` is in-memory on the per-directory server (it does **not** write the user's `opencode.json` — only the `opencode mcp add` CLI does) and *replaces* any entry with the same name, closing the old client. Two threads on one cwd registering plain `tide` would leave one live server holding whichever agent token registered last, so the other thread would act under a foreign identity. Trade-offs of the per-thread name: tools reach the model as `<name with non-alphanumerics → `_`>_<tool>`, i.e. `tide-<threadId>_tide_delegate`; and since every server registered for a directory is visible to every session in it, sibling threads sharing a cwd do see each other's tide tools — each with its own correct token. Cleanup on session close is `POST /mcp/{name}/disconnect` (SDK 1.18 has `mcp.status/add/connect/disconnect` and **no remove**): it closes the client, drops it from the directory's client map and leaves the status `disabled`.
- Plan mode = `plan` agent; ProposedPlan = the plan agent's completed assistant message, and a `plan_exit` permission is recorded as a plan and **auto-rejected** (Tide never lets the harness flip into editing).
- **Permission mapping** — the session ruleset sent to `POST /session`, in evaluation order
  (opencode takes the **last** match): **Tide's mode rules → the user's granular rules → Tide's link rules.**
  - Mode rules: approval-required → edit/bash/webfetch `*` `ask`; auto-accept-edits → edit `allow`, bash/webfetch `ask`; auto → all three `allow`; full-access → one `{permission:"*", pattern:"*", action:"allow"}`. `interaction: "plan"` keeps only the `ask` rules. `permission: "*"` is valid: `PermissionNext.Rule.permission` is a free-form string matched with `Wildcard.match`, and opencode's own defaults are built the same way.
  - **The mode rules cannot be dropped.** The built-in agents' baseline is `fromConfig({"*": "allow", doom_loop:"ask", external_directory:{…}, question:"deny", plan_enter:"deny", plan_exit:"deny", read:{…}})` (verified in the 1.1.36 binary), so *something* always matches and `evaluate`'s no-match `ask` never applies. Emitting no rules for approval-required would silently run the thread as **auto**.
  - **The user's own rules are replayed after Tide's** (`GET /config` → `cfg.permission`), but only the *granular* ones — an entry with a real pattern, e.g. `{"bash": {"git *": "allow", "rm -rf *": "deny"}}`. A blanket rule (a bare action, or pattern `*`) is the user's terminal-wide default; letting it win would make Tide's per-thread mode selector a lie. `~`/`$HOME` prefixes are expanded exactly as `PermissionNext.expand` does. The call is best-effort: an old server or any failure logs and falls back to mode rules alone.
  - Link rules stay last, so a read-only link's `edit: deny` always wins (W1).
- **A mode change cannot reach a resumed session.** `session.create` is the only writer of `session.permission`; `PATCH /session/:id` validates `{title?, time?}` only and `PromptInput` carries no permission field ("you can set permissions on the session itself now"). So `reconfigure` answers `reopen`, but a reopen that *resumes* the same native session still runs the creation-time ruleset — honouring a mode change needs a brand-new opencode session, at the cost of the native history. Escape hatch: `opencode -s <sessionId>`.

## Pi — `pi --mode rpc` (0.78+)

- NDJSON over stdio (pi 0.84): commands `prompt` (supports `images`), `abort`, `get_state`, `get_session_stats`, `get_available_models`, `extension_ui_response`, …; events `message_start|message_update|message_end` (deltas by `contentIndex`), `tool_execution_start|_end`, **`agent_settled` is the turn boundary** (not `agent_end`), `extension_ui_request` (confirm → approval card; `notify` = fire-and-forget channel the bridge uses for `TIDE_PLAN:`/`TIDE_USAGE:` lines), `response {id}`.
- Tide loads one extension, `@tide/pi-extensions` `tide-bridge` (mode from `TIDE_RUNTIME_MODE`, plan mode from `TIDE_INTERACTION`, `tide_propose_plan` tool). Usage = `get_session_stats` deltas per turn. Escape hatch: `pi --session <file>`.
- Extensions via `-e file.ts|js`; hooks `before_agent_start`, `tool_call` (return `{block, reason}`), `context`, `session_start`; `ctx.getContextUsage()`; `ctx.ui.confirm` → surfaces as `extension_ui_request`.
- **Tool classification is `read | write | command | unknown`.** A tool outside Tide's tables is `unknown`, not a write: it still asks for approval (in `approval-required` and `auto-accept-edits`), but it is never hard blocked — "absent from Tide's table" is no evidence that a tool mutates anything, and blocking the user's own extension and MCP tools is exactly the crippling §1a forbids.
- **Plan mode blocks known writes and mutating shell commands only.** A read-only command (allowlisted head on every segment, no redirection, no command substitution, no `sudo`) is research and runs; `unknown` tools take the normal approval path. The read-only-link block still applies, and covers `unknown` tools that name a concrete path under such a link.
- **Every `confirm` becomes an approval card.** A `TIDE_META:` first line carries tool name, input and diff; a confirm from one of the user's *own* extensions has none, so its title becomes the tool name and its message the description. It is asked, never auto-declined — silently answering "no" broke every extension that asks the user anything.
- **Lifecycle:** child `exit`/`error` settles the running turn with `pi exited with code N` and closes the mailbox (rejecting pending requests settles nothing once `prompt` has been acknowledged); `close()` sends `SIGTERM` then `SIGKILL` 5s later.
- Auth/models are Pi's (`~/.pi/agent/{auth,models}.json`); local models via Ollama (`:11434/api/tags`) / LM Studio (`:1234/v1/models`).

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
