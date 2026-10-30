# Remote: how a client reaches an environment

An *environment* is one machine running `tide-server`. A client (web, desktop, mobile) keeps
one connection per environment and merges their read models; nothing is shared between
servers. This page covers what one server exposes and how a client gets in.

## Running headless

```sh
tide serve [--host 0.0.0.0] [--port 3777] [--data <dir>] [--name <machine name>] [--web <dir>] [--log <file>]
tide pair [--port <n>] [--host <h>] [--no-qr]
tide doctor [--port <n>]
tide service install [serve flags] | uninstall | status
tide --version
```

- `tide serve` binds every interface by default. The no-subcommand form (desktop sidecar,
  `pnpm dev`) stays on `127.0.0.1`.
- On start it prints the environment id, the name, one `http://<ip>:<port>` line per routable
  IPv4 address, and one pairing code. It writes `<TIDE_HOME>/runtime.json` (`pid`, `host`,
  `port`) so `tide pair` and `tide doctor` find the port; the file is removed on shutdown.
- `--name` stores the machine name in `settings.environment.name` (default: the hostname).
- `--log <file>` mirrors console output to that file, rotated at 5 MB, keeping 3 files.
- `tide service install` writes `~/Library/LaunchAgents/com.tide.server.plist` (macOS,
  `launchctl bootstrap gui/<uid>`) or `~/.config/systemd/user/tide-server.service`
  (Linux, `systemctl --user enable --now`). The service runs the same binary as
  `serve --log <TIDE_HOME>/logs/server.log` with the installing shell's `PATH`, so the
  harness CLIs resolve, and `TIDE_HOME` when it was set. On Linux, `loginctl enable-linger`
  keeps it running after logout.
- The MCP server handed to provider sessions always dials loopback
  (`ws://127.0.0.1:<port>/ws`), whatever the bind address.

## HTTP routes (`apps/server/src/rpc/http.ts`)

| Route | Auth | CORS | Answer |
|---|---|---|---|
| `GET /health` | none | configured origins | `{ok, environmentId, version}` |
| `GET /api/env` | none | `*` | `EnvProbe {environmentId, name, version, protocol}` |
| `POST /api/auth/pair` `{code}` | pairing code | `*` | `PairResponse {environmentId, name, token}`; 400 bad body, 401 wrong/expired/used code, 429 rate-limited (`Retry-After: 60`) |
| `POST /api/auth/ws-ticket` | `Authorization: Bearer <token>` | `*` | `{ticket, expiresAt}` (single use, 5 min) |
| `POST /hook/<hookId>` | hook id, optional HMAC | none | fires a webhook task, see below |
| `GET /pair` | none | none | static explainer that reads `#token=` from the fragment |
| `GET /ws` (upgrade) | `wsTicket`, `agentToken`, or `token` (dev only) | n/a | the RPC socket |
| anything else, GET | none | none | the web client, or a pairing-instructions page at `/` |

**CORS stance.** Origins do not protect anything here. The token, a ticket, or a pairing code
does. Routes guarded by one of those, plus the public probe, answer `Access-Control-Allow-Origin: *`
so a client served from any origin (a hosted web app, a relay URL, a LAN address) can call
them. `/health` keeps the configured-origins rule (`TIDE_CORS_ORIGINS`, the dev server).

**Constant-time compares.** Bearer tokens, the dev `?token=`, pairing codes and webhook
signatures go through `safeEqual` (`crypto.timingSafeEqual`). Tickets are 256-bit random
map keys.

## Pairing

1. On the server machine, `tide pair` reads the token from `<TIDE_HOME>/server.json` (being able
   to read that file is the proof of being local), gets a ticket over loopback, and calls
   `env.pairingCode`. `tide serve` prints one code at start; the Environments UI can call the
   same RPC on an environment it is already connected to.
2. The code is 6 digits, valid 5 minutes, single use, held in memory only (a restart forgets it).
   `urls` lists the `http://<lan-ip>:<port>` bases, the relay's client URL when the relay is
   connected, or `http://127.0.0.1:<port>` on a loopback bind.
3. `tide pair` prints a QR of `<first url>/#pair=<code>`. The code rides in the fragment, which
   browsers never send to the server. The page at that URL (the bundled web client, or the
   fallback page) can read it.
4. The client posts `{code}` to `POST /api/auth/pair` on that base and stores the returned
   `token` with the environment (`KnownEnvironment.token`, client-side only).
5. To connect, the client exchanges the token for a ticket (`POST /api/auth/ws-ticket`) and opens
   `ws(s)://…/ws?wsTicket=<ticket>`.

Brute force: attempts are limited to 5 per minute per remote address, and after 20 wrong guesses
in total every outstanding code is burnt.

## Webhooks

A scheduled task with `schedule: {kind: "webhook", hookId, secret?}` never fires on the clock.
`POST /hook/<hookId>`:

- body up to 64 KB (413 above);
- unknown, paused or deleted hook: 404;
- when the task has a `secret`, `X-Tide-Signature: sha256=<hex HMAC-SHA256 of the raw body>` must
  match, otherwise 401;
- dispatches `task.fire` with commandId `hook:<hookId>:<first 16 hex of sha256(body)>`, so a
  retried delivery of the same body is a receipt replay (200, no second run);
- the turn's prompt is the task prompt plus `Webhook payload:` and the body as a fenced block
  (cut at 8 KB, fenced with `json` when the content type says so);
- 200 `{ok, taskId, threadId, turnId}`.

`hookId` is 8–64 characters of `[A-Za-z0-9_-]` and unique across all live tasks on the server
(the URL names no project). The relay forwards hook calls through the same
`handleWebhook(deps, hookId, rawBody, headers)` in `apps/server/src/scheduling/webhooks.ts`.

## `server.info` and the fleet view

`server.info` adds `name`, `host {hostname, os, arch, cpus, cpuLoad (1-min load / cpus, 0..1),
memTotal, memFree, busyThreads (threads with a turn running)}`, `harnesses [{kind, version?,
installed}]` for the four bundled harnesses, `sshHost` (settings), and `relay {url, connected,
clientUrl?}` when the relay client reports state.

`env.updateHarnesses {kinds?}` runs each harness's own updater (`claude update`,
`npm i -g @openai/codex@latest`, `opencode upgrade`,
`npm i -g @earendil-works/pi-coding-agent@latest`), streams the output lines, re-reads the
harness status, and ends the stream with `{done: true, ok}`. A harness with a running thread
is skipped. One update runs at a time per server.

## Web client

`tide serve` serves a built web client from `--web <dir>`, else `<binaryDir>/web` (compiled
binary; `scripts/build-server-sidecar.sh --with-web` puts it there), else `apps/web/dist` in a
source checkout. Unknown paths without an extension get `index.html` (client routes survive a
reload); missing `/assets/*` files are 404; `index.html` is `no-cache`, hashed assets are
immutable. No directory listings, no paths outside the root.

## Relay

A server behind NAT can dial out to a self-hosted relay (`settings.relay`). See
[`relay.md`](./relay.md).
