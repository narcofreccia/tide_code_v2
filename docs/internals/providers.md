# Provider drivers — harness facts (verified 2026-08-30)

Present tense, kept in sync with the code. Tide never re-implements login; each driver
runs the user's installed CLI/SDK and their subscription.

## Common mapping

| Tide `RuntimeMode`     | Claude `permissionMode` | Codex `approvalPolicy` / `sandboxPolicy`     | OpenCode permission | Pi |
|------------------------|-------------------------|----------------------------------------------|---------------------|----|
| approval-required      | `default`               | `unlessTrusted` / `workspaceWrite`           | ask                 | `tool_call` hook → ask |
| auto-accept-edits      | `acceptEdits`           | `onRequest` / `workspaceWrite`               | edits allow, bash ask | hook: writes allow |
| auto                   | `auto` (classifier)     | `onFailure` / `workspaceWrite`               | allow               | hook: allow, deny rm-critical |
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

## Codex — `codex app-server` (codex-cli 0.147)

- Start `codex app-server` (stdio JSON-RPC; also `--listen ws://127.0.0.1:PORT`). Handshake: `initialize {clientInfo}` → response → `initialized` notification.
- `thread/start {model, cwd, approvalPolicy, sandboxPolicy}` → `thread/started`; `thread/resume {threadId}`; `turn/start {threadId, input:[{type:'text',text}], cwd, model, effort, approvalPolicy, sandboxPolicy, collaborationMode?}`; `turn/interrupt {threadId, turnId}`.
- Notifications: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed` (authoritative), `turn/completed {status: completed|interrupted|failed}`, `thread/tokenUsage/updated`.
- Server→client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → reply `accept|acceptForSession|decline|cancel` (+`acceptWithExecpolicyAmendment`); then `serverRequest/resolved`.
- Collab (sub-agents): child threads with `agentThreadId`/nickname/role/depth; events `collabAgent/*` — render as child threads.
- Verified against generated bindings of codex-cli 0.147 (642 types): additional methods/notifications to use — `model/list`, `account/read` (login state), `account/rateLimits/read`, `thread/list|read|fork|archive|delete`, `thread/name/set`, `thread/compact/start`, `item/plan/delta` (**native plan output** → ProposedPlan), `item/tool/requestUserInput` (→ user-input activity), `item/permissions/requestApproval` (generic approvals), `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/reasoning/*Delta`, `item/mcpToolCall/progress`, `collabAgentToolCall` (sub-agents), `skills/list`, `mcpServerStatus/list`.
- **Exact bindings per installed version:** `codex app-server generate-ts --out packages/driver-codex/src/generated` (also `generate-json-schema`). Regenerate on codex upgrade; do not hand-write types.

## OpenCode — `opencode serve` + `@opencode-ai/sdk` (1.18.x)

- `opencode serve --port 0 --hostname 127.0.0.1` prints the bound URL; SDK `createOpencodeClient({ baseUrl })` (dist: `client`, `server` helper to spawn, `gen/` typed endpoints).
- Sessions (`session.create/prompt/abort`), SSE `event.subscribe` for message parts, permission events + `permission.respond`, `plan`/`build` agents, native file parts (images/text/PDF).

## Pi — `pi --mode rpc` (0.78+)

- NDJSON over stdio (pi 0.84): commands `prompt` (supports `images`), `abort`, `get_state`, `get_session_stats`, `get_available_models`, `extension_ui_response`, …; events `message_start|message_update|message_end` (deltas by `contentIndex`), `tool_execution_start|_end`, **`agent_settled` is the turn boundary** (not `agent_end`), `extension_ui_request` (confirm → approval card; `notify` = fire-and-forget channel the bridge uses for `TIDE_PLAN:`/`TIDE_USAGE:` lines), `response {id}`.
- Tide loads one extension, `@tide/pi-extensions` `tide-bridge` (mode from `TIDE_RUNTIME_MODE`, plan mode from `TIDE_INTERACTION`, `tide_propose_plan` tool). Usage = `get_session_stats` deltas per turn. Escape hatch: `pi --session <file>`.
- Extensions via `-e file.ts|js`; hooks `before_agent_start`, `tool_call` (return `{block, reason}`), `context`, `session_start`; `ctx.getContextUsage()`; `ctx.ui.confirm` → surfaces as `extension_ui_request`.
- Auth/models are Pi's (`~/.pi/agent/{auth,models}.json`); local models via Ollama (`:11434/api/tags`) / LM Studio (`:1234/v1/models`).
