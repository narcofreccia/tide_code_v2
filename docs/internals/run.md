# Run stack: starting a project's repos together

A project is often several repositories (backend, frontend, a desktop shell) that must run at once
on ports that do not collide. The run stack describes each repo once, plans the ports for the
selected services, and starts them in Tide terminals. The profile lives in the repo, not in the
event log: a linked repo is shared by several projects, the file travels with the clone, and it is
derived data that a rescan rebuilds.

## RunProfile

One per repo (`RunProfile` in `packages/contracts/src/domain.ts`):

- `repoKey`: the label other services use to refer to this repo (`[a-z0-9][a-z0-9_-]*`, default the
  directory name).
- `services[]`: `id` (slug), `name`, `cwd` (relative to the repo, default `.`), `command` (typed into
  the shell as written), `listens[]`, `connects[]`, static `env`, `readiness`, optional `kind`
  (`vite | tauri | expo | uvicorn | node | worker | other`), `dependsOn` (service ids), `default`
  (`false` = off until the user turns it on).
- `listens[]`: `name` (`http`, `hmr`, `ws`, `sync`), preferred `port`, and `how` a different port is
  handed over: `env` (`envVar`), `flag` (`flag`, `flagStyle` `space|equals`, optional `strictFlag`
  appended whenever a port is passed) or `fixed` (cannot move). `range` bounds the fallback search
  (default preferred+1 to preferred+50).
- `connects[]`: an env var that points at another service. `to` is `<repoKey>.<serviceId>[.<listen>]`,
  `template` may use `${port}` and `${host}` (this machine's LAN IP at plan time, never persisted).
  `?:<port>` marks a localhost URL the scanner saw but could not attribute to an owner yet.
- `readiness`: `{kind:"port", listen?}`, `{kind:"log", pattern}` or `{kind:"none"}`.
- `source` (`quickstart | manifest | model | user`), `manifestHash` (sha1 of the scanned manifests;
  a different hash on disk marks the profile **stale**), `generatedAt`, `warnings[]`.

Per project, `Project.runStack` (`project.runStack.set` -> `project.runStack.changed`) keeps which
services are on (`<repoKey>.<serviceId>`) and port pins (`<repoKey>.<serviceId>.<listen>` -> port).
With no `runStack`, every service not marked `default: false` is on.

## The QUICKSTART.md block

A fenced block tagged `tide-run` holding the profile as JSON. The last block in the file wins.
Example, the shape of `tide_frontend` (Vite pinned to 8081, API address taken from the backend):

````md
## Run with Tide

```tide-run
{
  "version": 1,
  "repoKey": "tide_frontend",
  "source": "quickstart",
  "manifestHash": "",
  "generatedAt": 0,
  "warnings": [],
  "services": [
    {
      "id": "web",
      "name": "Web",
      "kind": "vite",
      "cwd": ".",
      "command": "pnpm dev",
      "listens": [
        { "name": "http", "port": 8081, "how": "flag", "flag": "--port", "flagStyle": "space", "strictFlag": "--strictPort" }
      ],
      "connects": [
        { "env": "VITE_API_URL", "to": "tide_backend.api", "template": "http://localhost:${port}" }
      ],
      "env": {},
      "readiness": { "kind": "port", "listen": "http" }
    }
  ]
}
```
````

With a moved port the command becomes `pnpm dev --port 8082 --strictPort`: `--strictPort` makes Vite
fail loudly if the port is taken instead of drifting to another one the plan does not know about.
`VITE_API_URL` is re-rendered with whatever port `tide_backend.api` was assigned.

## Load precedence

1. the `tide-run` block in `QUICKSTART.md` (last block wins);
2. `<repo>/.tide/run.json` (written by Tide on every scan or edit; `.tide/` is already excluded
   through `info/exclude`);
3. a manifest scan (`package.json` scripts, `tauri.conf.json`, `pyproject.toml`, compose files...);
4. optionally the text model, only when the user asks ("Ask the model" sends the manifests and the
   file tree to the configured text model).

Tide writes the QUICKSTART block only on an explicit **Write QUICKSTART.md**: it replaces the block in
place, or appends a `## Run with Tide` section (prose table plus block). It never edits other prose.

## Planning, de-collision and env injection

`run.plan` is a dry run; `run.start` plans again and starts every row that is not blocked.

- Preferred ports are kept when free. A busy port (held by another selected service, or by an
  external process found with `lsof`) moves to the first free port in the listen's `range`, unless
  pinned. Pins win; a pin that is busy is a conflict, not a silent move.
- A moved port reaches the process three ways: an env var (`how: env`), a flag appended to the command
  (`how: flag`, plus `strictFlag`), or not at all (`how: fixed`, see limits).
- `connects` env vars are re-rendered from the assigned ports so each service finds its peers.
- Env is injected into the process environment only. Tide never edits `.env` files. A repo that loads
  `.env` with override semantics (`dotenv` with `override: true`, `load_dotenv(override=True)`) ignores
  injected values; the scanner flags this as a profile warning and the settings page shows it.
- `dependsOn` starts a service only when its dependencies are ready.
- Each service runs in its own terminal (`ownerId run:<projectId>`), so logs and Ctrl+C work as usual.

## Running from a thread's worktree

`run.plan` and `run.start` take an optional `threadId`. When that thread has a worktree, the
project's own repo (the root) runs from it: root rows get their `cwd` under the worktree, the plan
carries `rootPath`/`rootBranch`, and the session records `worktree {threadId, path, branch}` (restarts
stay on it). Linked repos keep their paths. The worktree is a full checkout, so its own
`QUICKSTART.md` or `.tide/run.json` wins; without either the main checkout's profile applies and
nothing is copied. The `repoKey` is the main checkout's either way. A project has one session: while
services run from one checkout, a plan from another adds a blocking `<rootRepoKey>.*` conflict
("stack already running from <branch or main checkout>; stop it first") and `run.start` refuses
with `conflict` unless forced. A fresh worktree usually has no `node_modules` or venv: a root
service that exits within 5 s, with neither `node_modules` (vite/tauri/expo/node) nor
`venv`/`.venv` (uvicorn/worker) in its cwd or the worktree root, fails with "dependencies missing in
this worktree"; the Run panel offers the install command to copy. The panel and the plan dialog show
which checkout the root runs from as a branch pill.

## Limits

- Tauri dev ports are fixed in `tauri.conf.json` (`devUrl`); they cannot move. Two fixed services
  on the same port block the plan; Tide shows both names and the line to edit, and never applies it.
- `${host}` is this machine's LAN IP at plan time (used for phones and simulators); it is not stored.
- A linked repo whose path is missing on this machine loads with `error` and is greyed out.
- Port readiness polls `lsof` about once a second per starting service, only during the start window.
- The session is ephemeral: processes and `RunSession` are lost with the server. Listeners that were
  started elsewhere show as `external`.

## RPC

| method | what |
| --- | --- |
| `run.profiles.get` | the project's repos (root and links) with their profiles as loaded now |
| `run.profiles.scan` | rescan one repo (`useModel` to ask the text model), writes `.tide/run.json` |
| `run.profiles.set` | save a user-edited profile (`source: "user"`) |
| `run.quickstart.write` | write or replace the `tide-run` block and prose table in `QUICKSTART.md` |
| `run.plan` | dry run: ports, rendered env, conflicts |
| `run.start` | start the plan; `conflict` when blocked unless `force` |
| `run.stop` | stop one service (`key`) or all |
| `run.restart` | restart one service |
| `run.subscribe` | stream: snapshot, then one chunk per service change |

Command: `project.runStack.set`. UI: Mission Control chip, Settings > Projects > Run, the Run panel in
the workbench Preview tab.
