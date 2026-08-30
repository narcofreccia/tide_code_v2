# Tide v2

A focused agentic code editor and orchestrator. Tide drives the coding harnesses you already pay for — **Claude Code, Codex, OpenCode, Pi** — from one place: many threads per repo, each on its own git worktree, each on any harness, with checkpoints, diffs, a real editor and terminal, and cross-harness Experts brainstorming. Server-centric and remote-ready.

Architecture (T3-Code style): a TypeScript `tide-server` owns everything (event-sourced orchestration, provider drivers, git, terminals, files); clients are thin — a browser app and a Tauri desktop shell that supervises the bundled server.

```
apps/server     tide-server: WS/HTTP · event store · decider/projector · drivers · vcs · pty · fs
apps/web        React 19 + Vite client (browser and Tauri WebView)
apps/desktop    Tauri v2 shell (later phase)
packages/contracts   TypeBox schemas: commands, events, read model, RPC table — single source of truth
packages/client      WebSocket client + projection store shared by web/mobile
packages/driver-*    provider drivers (later phases)
```

## Dev

```sh
nvm use            # node 22
pnpm install
pnpm dev           # server on :3777 (prints dev token) + web on :5173
pnpm test && pnpm typecheck
```
