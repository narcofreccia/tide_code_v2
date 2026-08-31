# Provider drivers — harness facts (verified 2026-08-30)

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

## Claude Code — `@anthropic-ai/claude-agent-sdk` (0.3.x)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` → `AsyncGenerator<SDKMessage>` + `interrupt()`, `setPermissionMode()`, `setModel()`.
- Options we use: `cwd`, `model`, `permissionMode`, `canUseTool`, `resume` (session id from `system/init`), `forkSession`, `mcpServers: Record<name, {type:'stdio', command, args, env}>`, `strictMcpConfig`, `systemPrompt: {type:'preset', preset:'claude_code', append}`, `includePartialMessages: true` (token streaming), `abortController`, `settingSources` (default all → user/project settings + skills apply), `env`, `stderr`.
- `canUseTool(toolName, input, { signal, suggestions, toolUseID, ... })` → `{behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message, interrupt?}`. Only called when no rule/mode auto-approved. `AskUserQuestion` always reaches it → map to `user-input.requested`. `ExitPlanMode` reaches it in plan mode → its `input.plan` (markdown) is the **ProposedPlan**; deny with a message to keep planning, allow = accept plan (we still never auto-implement; implementation is a new thread).
- Messages: `system/init` (session_id, model, tools, mcp_servers status), `assistant` (`message.content` blocks: text / tool_use / thinking; `parent_tool_use_id` non-null ⇒ inside a subagent; `subagent_type`, `task_description`), `user` (tool_result blocks), `stream_event` (`BetaRawMessageStreamEvent` deltas when partial messages on), `result` (`subtype success|error`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `permission_denials`), `system/compact_boundary`, `system/permission_denied`, `SDKTaskStarted/Updated/Progress` (background tasks / subagents), `SDKRateLimitEvent`.
- Plan progress: `TodoWrite` tool_use input `{todos:[{content,status,activeForm}]}`.
- Context usage: control request `get_context_usage`; cost: `get_session_cost`. `result.usage` has `input_tokens`, cache fields.

## Codex — `codex app-server` (codex-cli 0.147, verified against generated bindings + live)

- Start `codex app-server` (stdio JSON-RPC 2.0, newline-delimited). Handshake: `initialize {clientInfo}` → response → `initialized` notification.
- `thread/start {model, cwd, approvalPolicy, sandbox: "read-only"|"workspace-write"|"danger-full-access"}` → `thread/started`; `thread/resume {threadId}`; `turn/start {threadId, input:[{type:"text",text}], cwd, model, effort?, approvalPolicy, sandboxPolicy:{type:"workspaceWrite",writableRoots,…}, collaborationMode?}`; `turn/interrupt {threadId, turnId}`.
- **`approvalPolicy` values:** `"untrusted" | "on-request" | {granular:…} | "never"` — there is **no** on-failure policy. Tide mapping: approval-required → `untrusted`+workspace-write; auto-accept-edits → `on-request`+workspace-write; auto → `never`+workspace-write; full-access → `never`+`dangerFullAccess`.
- **Plan mode:** `turn/start.collaborationMode = {mode:"plan"|"default", settings:{model, reasoning_effort, developer_instructions:null}}` (absent from the ts-rs bindings but parsed strictly by the server; `null` instructions = Codex's native plan prompt). Streaming plan text = `item/plan/delta` → ProposedPlan. Plan/todo progress = `turn/plan/updated` (steps `pending|inProgress|completed`).
- Notifications: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta|patchUpdated`, `item/reasoning/*Delta`, `item/mcpToolCall/progress`, `item/completed` (authoritative), `turn/completed {status: completed|interrupted|failed}`, `thread/tokenUsage/updated {total, last, modelContextWindow}` (`last` = turn usage; `total`+window = context gauge), `model/rerouted`, `thread/settings/updated`.
- Server→client requests (must be answered or the turn hangs): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `accept|acceptForSession|decline|cancel` (no persistent grant; `acceptAlways` ⇒ `acceptForSession`); `item/permissions/requestApproval` → `{permissions, scope}` (decline = empty grant); `item/tool/requestUserInput` → `{answers:{[questionId]:{answers:string[]}}}` by option label; also `mcpServer/elicitation/request`, `item/tool/call`, `attestation/generate`, `account/chatgptAuthTokens/refresh`, legacy `applyPatchApproval`/`execCommandApproval`.
- Sub-agents: `collabAgentToolCall` and `subAgentActivity` are **`ThreadItem` variants** (via `item/started|completed`), not notifications → child activities.
- Login probe: `account/read` → `{account|null, requiresOpenaiAuth}`; models: `model/list` (works even signed out). Escape hatch: `codex resume <threadId>`.
- MCP: Tide's servers are added as `-c 'mcp_servers.<name>.command=…'` overrides at spawn — verified to **merge** with the user's own `mcp_servers` (non-crippling).
- **Exact bindings per installed version:** `pnpm --filter @tide/driver-codex regen` (runs `codex app-server generate-ts` and fixes `.ts` specifiers). Regenerate on codex upgrade; never hand-write types.

## OpenCode — `opencode serve` + `@opencode-ai/sdk` (opencode 1.1.36 / sdk 1.18, verified live)

- One managed `opencode serve --port 0 --hostname 127.0.0.1` **per instance** (a server started anywhere runs sessions in whatever `directory` they carry); URL parsed from stdout; `GET /global/health` → `{healthy, version}`.
- **Every route takes `?directory=`, including `event.subscribe`** — without it the SSE stream silently carries no session events.
- SDK methods used: `session.create` (accepts a per-session `permission` ruleset `{permission, pattern, action}[]` — newer than the SDK body type), `session.promptAsync` (returns `{}`; completion only via SSE `session.idle`), `session.abort`, `postSessionIdPermissionsPermissionId` (`once|always|reject`), `event.subscribe`, `config.providers` (models `provider/model`), `app.agents` (`plan`/`build`), `mcp.add`. Raw: `POST /question/{id}/reply {answers: string[][]}`.
- Events: `message.part.updated` (text `delta`, tool parts with state), `message.updated` (assistant `tokens`/`cost`), `permission.asked` (`id, permission, patterns, metadata, tool.{messageID,callID}`), `permission.replied`, `question.asked`, `todo.updated` → plan progress, `session.status` (`busy`/`retry` → info), `session.idle` → settled, `session.error`.
- Plan mode = `plan` agent; ProposedPlan = the plan agent's completed assistant message, and a `plan_exit` permission is recorded as a plan and **auto-rejected** (Tide never lets the harness flip into editing).
- Permission mapping: approval-required → edit/bash/webfetch `ask`; auto-accept-edits → edit `allow`, bash/webfetch `ask`; auto → all `allow`; full-access → `*` allow. Resumed sessions keep their original ruleset (`PATCH /session` only takes a title). Escape hatch: `opencode -s <sessionId>`.

## Pi — `pi --mode rpc` (0.78+)

- NDJSON over stdio (pi 0.84): commands `prompt` (supports `images`), `abort`, `get_state`, `get_session_stats`, `get_available_models`, `extension_ui_response`, …; events `message_start|message_update|message_end` (deltas by `contentIndex`), `tool_execution_start|_end`, **`agent_settled` is the turn boundary** (not `agent_end`), `extension_ui_request` (confirm → approval card; `notify` = fire-and-forget channel the bridge uses for `TIDE_PLAN:`/`TIDE_USAGE:` lines), `response {id}`.
- Tide loads one extension, `@tide/pi-extensions` `tide-bridge` (mode from `TIDE_RUNTIME_MODE`, plan mode from `TIDE_INTERACTION`, `tide_propose_plan` tool). Usage = `get_session_stats` deltas per turn. Escape hatch: `pi --session <file>`.
- Extensions via `-e file.ts|js`; hooks `before_agent_start`, `tool_call` (return `{block, reason}`), `context`, `session_start`; `ctx.getContextUsage()`; `ctx.ui.confirm` → surfaces as `extension_ui_request`.
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
  `merge(agent.permission, session.permission)`, so Tide's session rules win; the default
  with no match is `ask`. `Wildcard.match` compiles `*` to `.*` (it crosses `/`), so one
  `<path>/*` covers a tree. Permission keys include `read`, `edit`, `glob`, `grep`, `list`,
  `bash`, `external_directory`. Anything outside the project first hits
  `external_directory`, asked with the **absolute** glob of the target's parent dir — so
  allowing `<link>/*` there is what makes a link reachable at all. `edit` is asked with the
  path **relative to the worktree**, so read-only denies are emitted in both forms.
- **Pi**: `systemPromptAppend` has no RPC equivalent; the driver passes it as
  `TIDE_SYSTEM_PROMPT_APPEND` (plus `TIDE_CWD` / `TIDE_LINKED_DIRS`) and tide-bridge appends
  it in `before_agent_start`, alongside the plan-mode instructions.
- Links always point at the linked repo's real path — a thread in a worktree still reaches
  the link's own checkout. Link paths are stored as `realpath`s (resolved at the RPC
  boundary), and compared with `path.resolve` so trailing slashes and `.`/`..` never matter.
