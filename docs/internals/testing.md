# Transport-replay testing

Orchestration tests run the **real** driver, provider reactor, session directory, engine and
read model. Only the **transport** to the harness is fake: what the driver writes to a
process, an HTTP server or the Agent SDK is matched against a recorded transcript, and what the
harness answered is played back.

> Rule: only the transport is fake. Never stub a driver, a normalizer, a broker or the reactor
> in a replay test; if the behaviour under test lives above the transport, replay is the tool.
> (`provider/testing/fakeDriver.ts` stays for tests of the reactor/decider themselves.)

Package: `packages/driver-testing` (`@tide/driver-testing`). Server tests: `apps/server/src/replay/`.
Fixtures: `apps/server/test/fixtures/replay/<provider>/<scenario>.ndjson`.

## Seams (one per transport shape)

| Harness | Transport | Seam the driver already exposes | Adapter |
|---|---|---|---|
| Codex | stdio JSON-RPC child | `CodexConfig.spawnImpl` | `replaySpawn` / `recordSpawn` |
| Pi | stdio JSONL child | `createPiInstance(config, env, { spawn, probe, ... })` | `replaySpawn` / `recordSpawn` |
| OpenCode | HTTP + SSE | `OpencodeConfig.fetchImpl` (added for this) with `serverUrl` set | `replayFetch` / `recordFetch` |
| Claude | Agent SDK `query()` | `ClaudeConfig.queryImpl` | `replayQuery` / `recordQuery` |
| ACP agents | stdio ndjson JSON-RPC child | `createAcpInstance(config, env, { spawn, timers })` (status probe spawns too) | `replaySpawn` / `recordSpawn` (`replayAcpDriver`, `recordAcpDriver`; record defaults to `opencode acp`) |

`replayCodexDriver(replay)`, `replayPiDriver`, `replayOpencodeDriver`, `replayClaudeDriver` wrap
the production driver with the seam filled in (and `binaryPath` pointing at node, so "is the CLI
installed" passes without one). Pi's status check reads `~/.pi/agent` and API keys from the
environment: call `isolatePiLogin()` in `beforeEach` so the transcript does not depend on the machine.

## Transcript format

One JSON object per line.

```jsonc
{"t":"start","provider":"codex","version":"0.147.0","scenario":"steer-mid-turn","synthetic":true}
{"t":"expect_out","match":{"method":"turn/start","params":{"threadId":"thread-1"}}}   // what the driver must send
{"t":"in","frame":{"jsonrpc":"2.0","id":"$id","result":{"turn":{"id":"turn-7"}}}}      // what the harness sends back
{"t":"proc","name":"status-probe"}                                                      // next process / query() call
{"t":"exit","code":0}
```

- `synthetic: true` marks a hand-authored transcript; recordings omit it.
- **Matching** is a JSON subset: extra keys in the actual frame are fine; arrays must have the same
  length. A string `"/re/flags"` is a regex, `"$any"` matches any present value, any other string is
  exact. A top-level string `match` is a pattern over the serialised frame (regex if slashed, else substring).
  A mismatch throws from the driver's write with every differing path plus expected and actual,
  and is also kept so `assertDrained()` fails even when the driver swallows the exception.
- **Delivery:** after an `expect_out` matches, every following `in` frame is delivered, in order,
  until the next `expect_out` (or `exit`). A transcript therefore *parks* the harness at an
  `expect_out`: an approval card stays pending until the test dispatches `approval.respond`.
  `"$id"` inside an `in` frame becomes the `id` of the last matched outbound frame.
- **Processes:** a `proc` frame starts the next process. They are handed out in the order the driver
  spawns them (Codex's status probe is a second `app-server`; the reactor spawns it when it reads
  capabilities for a steer, rollback or handoff).
- Per shape:
  - stdio: `match` / `frame` are the parsed JSON lines.
  - HTTP: `match` is `{method, path, body?}` (path includes the query string, origin and headers are
    ignored); `in` is `{status, body?}`, `{status, stream:true}` to open the SSE stream, then
    `{sse: <event>}`, `{sseRaw: "..."}`, `{sseEnd:true}`.
  - SDK: `match` is `{kind:"query", options}` (env and callbacks stripped; `canUseTool` shows as `true`),
    `{kind:"prompt", message}`, `{kind:"control", method, args}`, `{kind:"permission", toolName, result}`;
    `in` is an SDK message, `{callback:"canUseTool", toolName, input, toolUseID}` to invoke the permission
    callback, or `{control_result: value}` as the return value of the pending control call.

## Writing a replay test

```ts
const replay = loadReplay("codex", "turn-with-approval");
const codex = replayCodexDriver(replay);
const h = await bootReplay([codex.driver]);          // createApp with the real driver registered
const thread = await h.newThread("codex");
await h.request(thread.id, "remove the build directory");
await h.until((m) => Object.values(m.activities).some((a) => a.kind === "approval" && a.status === "pending"));
await h.app.engine.dispatch({ type: "approval.respond", threadId: thread.id, requestId: "srv-1", decision: "accept" });
await h.app.reactor.drain();
// assert on h.model(), h.events, h.activities(), h.messages() ...
replay.assertDrained();                              // every expect_out consumed, nothing unexpected sent
```

Wait with `h.until` (event subscription) or `reactor.drain()` / `rollback.drain()`, never sleeps.

## Adding a scenario

1. Record (preferred) or hand-write `<provider>/<scenario>.ndjson` (set `"synthetic": true`).
2. Write a test in `apps/server/src/replay/<provider>.test.ts`.
3. Run it; mismatches name the frame. Surplus requests (the driver also sent X) mean the transcript
   is missing a step, not that the test is wrong: add the frames.

## Recording

Needs the real CLI installed and logged in (not run in CI):

```sh
pnpm --filter @tide/driver-testing record -- codex turn-with-approval --prompt "remove the build dir" --approve
pnpm --filter @tide/driver-testing record -- opencode rollback --prompt "one" --prompt "two" --rollback 1
```

The script boots the server stack in a scratch `TIDE_HOME` and a throwaway git repo with the real
driver's transport tapped by a `Recorder`, runs the prompts through the engine (`--approve`,
`--steer <text>`, `--rollback <n>`, `--mode`), and writes the ndjson. Values under secret-looking keys
are masked (`$any` outbound, `[redacted]` inbound), but review the file before committing: prompts,
paths, emails and model output are recorded as they were. Live-recorded `in` frames are in wire order, so a
prompt response and the first SSE events may be swapped relative to a hand-written transcript; both replay.
