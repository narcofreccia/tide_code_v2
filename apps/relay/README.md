# @tide/relay

A tiny self-hosted relay for Tide. Your tide-servers dial out to it; clients that cannot reach a
server directly connect to the relay and get a tunnel to it. It also holds webhooks for an offline
server for up to 24 h. Protocol and limits: [`docs/internals/relay.md`](../../docs/internals/relay.md).

One secret, one port, one SQLite file. No accounts: each tide-server still authenticates its clients.

## Run

```sh
export RELAY_KEY=$(openssl rand -hex 32)   # keep it: every tide-server needs it
```

**Docker (any VPS)**

```sh
docker build -t tide-relay apps/relay
docker run -d --name tide-relay --restart unless-stopped -p 8787:8787 -v tide-relay:/data -e RELAY_KEY=$RELAY_KEY tide-relay
```

Put TLS in front, e.g. Caddy: `caddy reverse-proxy --from relay.example.com --to localhost:8787`.

**Fly.io**

```sh
cd apps/relay && cp fly.toml.example fly.toml   # edit `app`
fly launch --no-deploy --copy-config && fly volumes create relay_data --size 1
fly secrets set RELAY_KEY=$RELAY_KEY && fly deploy
```

**Railway / Render**: deploy `apps/relay` as a Dockerfile service, set `RELAY_KEY`, mount a volume at
`/data`, keep one always-on instance (the uplinks are long-lived WebSockets).

**Bare Node ≥ 22.13**

```sh
cd apps/relay && npm install --omit=dev && RELAY_KEY=$RELAY_KEY npm start
```

| env | default | |
|---|---|---|
| `RELAY_KEY` | — (required, ≥ 16 chars) | shared secret environments present |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `RELAY_DB` | `relay.db` (`/data/relay.db` in Docker) | held webhooks |

## Connect a tide-server

Settings → Environments → Relay: URL `https://relay.example.com` and the key. The server then shows
its client URL `https://relay.example.com/c/<environmentId>`. Webhooks for it go to
`https://relay.example.com/hook/<environmentId>/<hookId>`.

`GET /health` → `{ok, environments}`.
