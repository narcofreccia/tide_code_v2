# @tide/e2e: browser smoke test

Two Playwright specs drive the real app in Chrome against a scratch tide-server: `smoke.e2e.ts`
(the main walk) and `devices.e2e.ts` (pairing a second browser and its access level; the
`devices` project depends on `smoke` and reuses the project and threads it leaves). Local
only: nothing in CI runs it (Actions minutes are paid; see the account rules).

```sh
source ~/.nvm/nvm.sh && nvm use 22
pnpm e2e                         # from the repo root, ~15 s once apps/web/dist is fresh
pnpm e2e --project smoke         # the main walk only
pnpm e2e --headed                # watch it
pnpm e2e --debug                 # Playwright inspector, step by step
TIDE_E2E_KEEP=1 pnpm e2e         # keep the temp dir (server.log, repo, TIDE_HOME) for a look
pnpm --filter @tide/e2e exec playwright show-report
pnpm --filter @tide/e2e exec playwright show-trace test-results/<test>/trace.zip
```

The browser is the installed Google Chrome (`channel: "chrome"`) when it is at the usual macOS
path; otherwise, or with `TIDE_E2E_CHROMIUM=1`, Playwright's own chromium, installed once with
`pnpm --filter @tide/e2e exec playwright install chromium`.

A failing step keeps a screenshot and a trace under `test-results/`; the later steps are skipped
(the spec is serial and shares one page).

## How it boots

`global-setup.ts`:

1. Builds `apps/web` when `dist/index.html` is missing or older than any file under
   `apps/web/src`, `packages/client/src` or `packages/contracts/src` (~25 s; skipped otherwise).
2. Creates `$TMPDIR/tide-e2e-*` with `repo/` (git repo, one commit, `hello.txt`), `home/`
   (empty HOME with a git identity), `tide-home/` (`server.json` with a fixed token,
   `settings.json` adding the fake agent and `git.generateMessages: false`) and `bin/` (node
   and git only).
3. Starts `node apps/server/src/bin.ts serve --host 127.0.0.1 --port <free> --web apps/web/dist`
   with an environment built from scratch (that HOME and PATH), and waits for its banner. The
   page opens `/?token=…` on that origin. Ports 3777/5173 and `~/.tide` are never used.
4. Teardown stops the server (and whichever one `state.json` names last: the reconnect step and
   `devices.e2e.ts` start their own) and removes the temp dir.

## The fake harness

`fixtures/fake-agent.ts` is an Agent Client Protocol agent (ndjson JSON-RPC on stdio) that Tide
runs like any other ACP agent: `providerInstances: [{ id: "acp:e2e", kind: "acp", command: node,
args: [fake-agent.ts] }]`. No server code is test-aware. Its script (`fixtures/script.ts`): a
prompt containing "please edit hello.txt" streams two text chunks, announces an `edit` tool call
with a diff, asks `session/request_permission`, and on approval writes the file through Tide's
`fs/write_text_file` (inside the worktree); any other prompt is answered `Echo: <prompt>`. It
exits when its stdin closes, so a killed server leaves no agent behind.

Specs are `specs/*.e2e.ts`, which no vitest config collects.
