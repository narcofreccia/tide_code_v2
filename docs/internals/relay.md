# Relay

`apps/relay` (`@tide/relay`) is a small self-hosted rendezvous server. You run one on any VPS;
each tide-server ("environment") dials out to it and keeps a WebSocket open. A client that cannot
reach an environment directly (phone on cellular, laptop behind another NAT) talks to the relay
instead and gets a byte-for-byte tunnel to that environment's WS and HTTP. The relay holds no
identity: the environment still authenticates every client itself (ws ticket or dev token, pairing).
The relay also receives webhooks for an environment and holds them for up to 24 h while it is offline.

Code: `apps/relay/src/{relay,hooks,protocol,bin}.ts` (relay side),
`apps/server/src/relay/client.ts` (environment side, wired in `app.ts` as `app.relay`).

## Endpoints (one port, HTTP + WS)

| Request | Who | What |
|---|---|---|
| `GET /health` | anyone | `{ok: true, environments: n}` |
| `GET /env/connect?env=<environmentId>&key=<RELAY_KEY>` → WS | environment | the uplink. Bad key → `401` before the upgrade; missing env → `400`. |
| `GET /c/<envId>/ws<query>` → WS | client | a tunnel channel to the environment's `/ws<query>` (`?wsTicket=` / `?token=` pass through). Offline → `503`, more than 64 channels → `429`. |
| `ANY /c/<envId>/<path>` | client | forwarded to `http://<loopback>/<path>` on the environment. CORS `*`; `OPTIONS` answered by the relay. Offline → `503`, no answer in 60 s or uplink lost → `504`. |
| `GET /c/<envId>/_relay/info` | client | `{online: bool}` — route preflight, answered by the relay itself |
| `POST /hook/<envId>/<hookId>` | webhook sender | forwarded to the environment's `POST /hook/<hookId>`; held when offline (below) |

`RELAY_KEY` is one shared secret per relay, so only your machines can register. Environment ids are
self-asserted; one id has at most one live uplink: a newer uplink wins and the older is closed with
`4409 superseded` (its channels close `1012`).

## Uplink wire format

Text frames are JSON control messages; binary frames are tunnel data:

```
binary: [u32 BE channel][u8 kind: 0 text | 1 binary][payload bytes]
```

The kind byte preserves the client frame's text/binary flag, so the environment sees exactly what the
client sent.

relay → environment:

```jsonc
{ "t": "open",  "c": 1, "path": "/ws?wsTicket=…" }      // a client connected to /c/<env>/ws
{ "t": "close", "c": 1, "code": 1000, "reason": "" }     // the client went away
{ "t": "http",  "id": 7, "method": "POST", "path": "/api/auth/pair?x=1",
  "headers": { "content-type": "…", "x-tide-relay": "1" }, "body": "<base64>" }
```

environment → relay:

```jsonc
{ "t": "close", "c": 1, "code": 4401, "reason": "unauthorized" }   // loopback socket closed
{ "t": "res",   "id": 7, "status": 201, "headers": { … }, "body": "<base64>" }
```

Channel ids are per uplink, assigned by the relay. Data for a channel the environment has not finished
opening is queued by the environment client. Close codes that cannot be sent on the wire
(1005/1006/1015) map to 1000/1011. Hop-by-hop headers (`host`, `connection`, `content-length`,
`transfer-encoding`, …) and `content-encoding` (fetch decodes) are dropped on both legs; the relay
replaces any `access-control-*` from the environment with its own `*`.

Every relayed HTTP request and loopback WS upgrade carries **`x-tide-relay: 1`**. The environment
sees these as loopback connections, so anything that trusts `req.socket.remoteAddress` (pairing
rate limits, "local only" endpoints) must treat `x-tide-relay` as remote. The environment client
always sets it, so relayed traffic can never pass as local; a direct client setting it only makes
itself look remote.

## Webhooks

`POST /hook/<envId>/<hookId>`, body ≤ 256 KB (`413` above; the server itself caps hooks lower — see
`WEBHOOK_MAX_BODY` in `apps/server/src/scheduling/webhooks.ts`).

- Online and nothing held: forwarded as an `http` frame to `/hook/<hookId>`; the environment's
  status and body go back to the sender.
- Offline (or the uplink drops mid-request, or older hooks are still queued): stored in SQLite
  (`{id, envId, hookId, headers, body, receivedAt}` in `relay.db`), answered `202 {queued: true}`,
  and replayed in arrival order as soon as the environment's uplink connects. A held hook is removed
  once the environment answers (a 5xx on replay is logged and dropped); it stays if the uplink dies first.
- Everything older than 24 h is dropped (checked on every read and on each keepalive sweep).
- `X-Tide-Delivery: <id>` dedupes per environment for 24 h: a repeat gets `200 {duplicate: true}`.
  When the online environment answers 5xx, the id is forgotten so the sender's own retry goes through.

## Limits and liveness

| | |
|---|---|
| tunnel WS frame | 16 MB |
| http request / response body | 8 MB (`413` / `502 response-too-large`) |
| webhook body | 256 KB |
| channels per environment | 64 |
| keepalive | WS ping every 20 s both ways (relay → uplink and channels, environment → relay); a peer that missed a pong is terminated |
| idle channel | no data either way for 1 h → closed `1001 idle` |
| backlog | a channel whose uplink has > 32 MB unsent is closed `1013` |

The relay logs connects and disconnects (environment id, count) and never logs bodies, headers or keys.

## Environment client

`createRelayClient({environmentId, port, host})` in `apps/server/src/relay/client.ts`:

- dials `<relay>/env/connect?env=…&key=…` (`http(s)://` and `ws(s)://` relay URLs both work), with
  backoff 1 s → 2 s → … → 60 s, reset after a successful connect;
- `open` → a loopback `ws://<host>:<port><path>` (only `/ws…` paths; others are refused `4404`);
- `http` → `fetch("http://<host>:<port><path>")`, `redirect: "manual"`; `//…` paths are refused;
  webhooks therefore hit the server's own `POST /hook/<id>` handler;
- `state()` → `{url, connected, clientUrl: "<relay http origin>/c/<envId>"}` for `server.info`;
- `restart(cfg | undefined)` reconnects or disconnects; `stop()` on app close.

`startRelayClient(settings, …)` starts from `settings.relayConfig()` and wraps `settings.set` so a
patch carrying `relay` restarts the client (the settings store has no change feed).

## Client routes

A client reaches an environment through the relay with:

- WS: `wss://relay.example/c/<envId>/ws?wsTicket=<ticket>`
- HTTP origin: `https://relay.example/c/<envId>` (e.g. `…/c/<envId>/api/auth/ws-ticket`,
  `…/c/<envId>/api/env`, static web assets)
- preflight: `GET https://relay.example/c/<envId>/_relay/info` → `{online}`

## Deploy

See `apps/relay/README.md`. Terminate TLS in front of the relay (Fly, Caddy, nginx); the relay itself
speaks plain HTTP on `PORT` (default 8787).
