import { Type, type Static, type TSchema } from "typebox";
import { AgentCommand, ClientCommand } from "./commands.ts";
import { EventRecord } from "./events.ts";
import { ProviderKind, ReadModel } from "./domain.ts";

// ---- wire envelope ----
// client -> server
export const RpcRequest = Type.Object({ id: Type.String(), method: Type.String(), params: Type.Unknown() });
export type RpcRequest = Static<typeof RpcRequest>;
// server -> client (exactly one of result/error/chunk/end per frame)
/** The only machine codes a server may put on the wire. Add here, never invent ad hoc. */
export const RPC_ERROR_CODES = [
  "invalid-command", // decider rejected the command's content
  "not-found",
  "conflict", // state does not allow it (already settled, archived, duplicate requestId, …)
  "busy", // a live turn blocks it
  "forbidden", // this connection / caller may not do it
  "invalid-params", // malformed frame or RPC params
  "method-not-found",
  "internal",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];
export const RpcError = Type.Object({ code: Type.String(), message: Type.String(), data: Type.Optional(Type.Unknown()) });
export type RpcError = Static<typeof RpcError>;
export const RpcFrame = Type.Union([
  Type.Object({ id: Type.String(), result: Type.Unknown() }),
  Type.Object({ id: Type.String(), error: RpcError }),
  Type.Object({ id: Type.String(), chunk: Type.Unknown() }),
  Type.Object({ id: Type.String(), end: Type.Literal(true) }),
]);
export type RpcFrame = Static<typeof RpcFrame>;

// ---- method table ----
// unary: params -> result. stream: params -> chunk*, end. `unsubscribe` cancels a stream by id.
export interface UnaryMethod<I extends TSchema, O extends TSchema> { kind: "unary"; input: I; output: O }
export interface StreamMethod<I extends TSchema, C extends TSchema> { kind: "stream"; input: I; chunk: C }
const unary = <I extends TSchema, O extends TSchema>(input: I, output: O): UnaryMethod<I, O> => ({ kind: "unary", input, output });
const stream = <I extends TSchema, C extends TSchema>(input: I, chunk: C): StreamMethod<I, C> => ({ kind: "stream", input, chunk });

export const DispatchResult = Type.Object({ seq: Type.Number(), events: Type.Array(EventRecord) });

/** Subscription chunk: first frame is a snapshot, then event records. */
export const ModelChunk = Type.Union([
  Type.Object({ kind: Type.Literal("snapshot"), model: ReadModel }),
  Type.Object({ kind: Type.Literal("event"), record: EventRecord }),
]);
export type ModelChunk = Static<typeof ModelChunk>;

export const ProviderStatusDto = Type.Object({
  kind: ProviderKind,
  installed: Type.Boolean(),
  loggedIn: Type.Boolean(),
  version: Type.Optional(Type.String()),
  hint: Type.Optional(Type.String()),
  loginCommand: Type.Optional(Type.String()),
  models: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), family: Type.Optional(Type.String()), default: Type.Optional(Type.Boolean()) })),
  caps: Type.Object({
    planMode: Type.Boolean(), subagents: Type.Boolean(), mcp: Type.Boolean(), images: Type.Boolean(),
    resume: Type.Boolean(), contextUsage: Type.Boolean(), openInTerminal: Type.Boolean(),
  }),
});
export type ProviderStatusDto = Static<typeof ProviderStatusDto>;

export const DiffFile = Type.Object({
  path: Type.String(),
  oldPath: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed")]),
  additions: Type.Number(),
  deletions: Type.Number(),
  /** unified patch for this file; absent for binary */
  patch: Type.Optional(Type.String()),
  binary: Type.Optional(Type.Boolean()),
});
export type DiffFile = Static<typeof DiffFile>;
/** W1: uncommitted changes in a write-access linked repo, alongside the main repo's diff. */
export const LinkedChanges = Type.Object({
  linkId: Type.String(),
  label: Type.String(),
  path: Type.String(),
  files: Type.Array(Type.Object({ path: Type.String(), status: Type.String() })),
});
export type LinkedChanges = Static<typeof LinkedChanges>;
export const DiffResult = Type.Object({
  base: Type.String(),
  head: Type.String(),
  files: Type.Array(DiffFile),
  /** W1: per-linked-repo working-tree changes; absent when the thread has no write links */
  linked: Type.Optional(Type.Array(LinkedChanges)),
});
export type DiffResult = Static<typeof DiffResult>;

export const VcsStatus = Type.Object({
  cwd: Type.String(),
  isRepo: Type.Boolean(),
  branch: Type.Optional(Type.String()),
  worktree: Type.Boolean(),
  dirty: Type.Number(),
  ahead: Type.Optional(Type.Number()),
  behind: Type.Optional(Type.Number()),
  hasGh: Type.Boolean(),
  hasRemote: Type.Boolean(),
});
export type VcsStatus = Static<typeof VcsStatus>;

// ---- workspace files & terminals (P3). All paths are relative to the thread's cwd
// (worktree or project root) and validated server-side; ".." escapes are rejected. ----
export const FsEntry = Type.Object({
  name: Type.String(),
  path: Type.String(),
  kind: Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("symlink")]),
  size: Type.Optional(Type.Number()),
  mtime: Type.Optional(Type.Number()),
  /** true when .gitignore'd (client dims it) */
  ignored: Type.Optional(Type.Boolean()),
});
export type FsEntry = Static<typeof FsEntry>;

export const FsChange = Type.Object({
  path: Type.String(),
  kind: Type.Union([Type.Literal("created"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed")]),
  at: Type.Number(),
});
export type FsChange = Static<typeof FsChange>;

export const SearchMatch = Type.Object({
  path: Type.String(),
  line: Type.Number(),
  column: Type.Number(),
  text: Type.String(),
});
export type SearchMatch = Static<typeof SearchMatch>;

export const PtyChunk = Type.Union([
  Type.Object({ kind: Type.Literal("data"), data: Type.String() }),
  Type.Object({ kind: Type.Literal("exit"), code: Type.Optional(Type.Number()), signal: Type.Optional(Type.String()) }),
]);
export type PtyChunk = Static<typeof PtyChunk>;

export const ServerInfo = Type.Object({
  environmentId: Type.String(),
  version: Type.String(),
  startedAt: Type.Number(),
  tideHome: Type.Optional(Type.String()),
  worktreeRoot: Type.Optional(Type.String()),
  /** tools detected on the server host */
  tools: Type.Optional(Type.Object({ git: Type.Boolean(), gh: Type.Boolean(), rg: Type.Boolean() })),
  /** how clients reach this server; pairingUrl embeds the token — show only to the local user */
  remote: Type.Optional(Type.Object({ host: Type.String(), port: Type.Number(), lanUrls: Type.Array(Type.String()), pairingUrl: Type.Optional(Type.String()) })),
});

export const rpcMethods = {
  "server.info": unary(Type.Object({}), ServerInfo),
  /** validated command -> persisted events */
  /** client commands only; internal commands are rejected with `forbidden` */
  "orchestration.dispatch": unary(Type.Object({ command: ClientCommand }), DispatchResult),
  /** installed/logged-in state + models per harness (cached server-side) */
  "providers.list": unary(Type.Object({ refresh: Type.Optional(Type.Boolean()) }), Type.Array(ProviderStatusDto)),
  /** escape hatch: shell command that reopens the thread's harness session in a terminal */
  "thread.terminalCommand": unary(Type.Object({ threadId: Type.String() }), Type.Object({ cwd: Type.String(), command: Type.Optional(Type.String()) })),
  /** full model snapshot then live events; `fromSeq` skips the snapshot when the client already has one */
  "model.subscribe": stream(Type.Object({ fromSeq: Type.Optional(Type.Number()) }), ModelChunk),
  "model.get": unary(Type.Object({}), ReadModel),
  "unsubscribe": unary(Type.Object({ id: Type.String() }), Type.Object({ ok: Type.Boolean() })),
  /** git state of the thread's cwd (worktree or project root) */
  "vcs.status": unary(Type.Object({ threadId: Type.String() }), VcsStatus),
  /** diff produced by one turn (before → after checkpoint); `after` falls back to the working tree while running */
  "vcs.turnDiff": unary(Type.Object({ threadId: Type.String(), turnId: Type.String() }), DiffResult),
  /** everything this thread changed: first checkpoint (or base branch) → working tree */
  "vcs.threadDiff": unary(Type.Object({ threadId: Type.String() }), DiffResult),
  /** W1: discard working-tree changes in one linked repo (never touches anything outside it) */
  "vcs.linkedRevert": unary(
    Type.Object({ threadId: Type.String(), linkId: Type.String(), files: Type.Optional(Type.Array(Type.String())) }),
    Type.Object({ reverted: Type.Array(Type.String()) }),
  ),
  // fs
  "fs.list": unary(Type.Object({ threadId: Type.String(), path: Type.Optional(Type.String()) }), Type.Object({ entries: Type.Array(FsEntry) })),
  "fs.read": unary(
    Type.Object({ threadId: Type.String(), path: Type.String() }),
    Type.Object({ content: Type.Optional(Type.String()), binary: Type.Boolean(), size: Type.Number(), mtime: Type.Number() }),
  ),
  /** optimistic concurrency: when `ifMtime` is given and the file changed since, returns conflict */
  "fs.write": unary(
    Type.Object({ threadId: Type.String(), path: Type.String(), content: Type.String(), ifMtime: Type.Optional(Type.Number()) }),
    Type.Object({ mtime: Type.Number() }),
  ),
  "fs.create": unary(Type.Object({ threadId: Type.String(), path: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("dir")]) }), Type.Object({ ok: Type.Boolean() })),
  "fs.rename": unary(Type.Object({ threadId: Type.String(), from: Type.String(), to: Type.String() }), Type.Object({ ok: Type.Boolean() })),
  "fs.delete": unary(Type.Object({ threadId: Type.String(), path: Type.String() }), Type.Object({ ok: Type.Boolean() })),
  /** recursive change stream for the thread's cwd (debounced, gitignore-aware) */
  "fs.watch": stream(Type.Object({ threadId: Type.String() }), FsChange),
  /** text search (ripgrep when available) */
  "fs.search": unary(
    Type.Object({ threadId: Type.String(), query: Type.String({ minLength: 1 }), regex: Type.Optional(Type.Boolean()), caseSensitive: Type.Optional(Type.Boolean()), glob: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    Type.Object({ matches: Type.Array(SearchMatch), truncated: Type.Boolean() }),
  ),
  /** directory browser for the project picker: absolute paths on the server host, starting at home */
  "fs.browse": unary(
    Type.Object({ path: Type.Optional(Type.String()), showHidden: Type.Optional(Type.Boolean()) }),
    Type.Object({
      path: Type.String(),
      parent: Type.Optional(Type.String()),
      home: Type.String(),
      isGitRepo: Type.Boolean(),
      dirs: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), isGitRepo: Type.Boolean() })),
      /** recently used project roots (from existing projects), newest first */
      recent: Type.Array(Type.String()),
    }),
  ),
  // pty
  "pty.create": unary(
    Type.Object({ threadId: Type.String(), cols: Type.Number(), rows: Type.Number(), shell: Type.Optional(Type.String()) }),
    Type.Object({ ptyId: Type.String() }),
  ),
  /** attaches to a pty: replays the scrollback buffer, then streams output until exit */
  "pty.attach": stream(Type.Object({ ptyId: Type.String() }), PtyChunk),
  "pty.write": unary(Type.Object({ ptyId: Type.String(), data: Type.String() }), Type.Object({ ok: Type.Boolean() })),
  "pty.resize": unary(Type.Object({ ptyId: Type.String(), cols: Type.Number(), rows: Type.Number() }), Type.Object({ ok: Type.Boolean() })),
  "pty.kill": unary(Type.Object({ ptyId: Type.String() }), Type.Object({ ok: Type.Boolean() })),
  "pty.list": unary(Type.Object({ threadId: Type.String() }), Type.Object({ ptys: Type.Array(Type.Object({ ptyId: Type.String(), title: Type.Optional(Type.String()), alive: Type.Boolean() })) })),
  // agent-facing (Tide MCP server; socket authenticated with a per-thread agent ticket → ctx.agentThreadId)
  /** experts board / delegation commands; the server stamps author/from/fromThreadId from the authenticated thread */
  "agent.dispatch": unary(Type.Object({ command: AgentCommand }), DispatchResult),
  /** what the calling thread needs to know: its experts session (if any), unread messages, findings */
  "agent.context": unary(
    Type.Object({ sinceMessageId: Type.Optional(Type.String()) }),
    Type.Object({
      threadId: Type.String(),
      role: Type.Optional(Type.String()),
      expertKey: Type.Optional(Type.String()),
      session: Type.Optional(Type.Object({ id: Type.String(), topic: Type.String(), phase: Type.String(), experts: Type.Array(Type.Object({ key: Type.String(), name: Type.String(), role: Type.String(), provider: Type.String(), status: Type.String() })) })),
      findings: Type.Array(Type.Object({ id: Type.String(), author: Type.String(), text: Type.String(), createdAt: Type.Number() })),
      messages: Type.Array(Type.Object({ id: Type.String(), from: Type.String(), to: Type.String(), text: Type.String(), createdAt: Type.Number() })),
    }),
  ),
  /** status + last assistant text of a thread this agent delegated */
  "agent.threadStatus": unary(
    Type.Object({ threadId: Type.String() }),
    Type.Object({ status: Type.String(), attention: Type.Optional(Type.String()), lastAssistantText: Type.Optional(Type.String()), settled: Type.Boolean(), error: Type.Optional(Type.String()) }),
  ),
  /** full contents of a file at a ref (or the working tree when ref is "WORKTREE"), for side-by-side views */
  "vcs.fileAt": unary(
    Type.Object({ threadId: Type.String(), ref: Type.String(), path: Type.String() }),
    Type.Object({ content: Type.Optional(Type.String()), binary: Type.Boolean(), missing: Type.Boolean() }),
  ),
} as const;

export type RpcMethods = typeof rpcMethods;
export type RpcMethodName = keyof RpcMethods;
export type RpcInput<M extends RpcMethodName> = Static<RpcMethods[M]["input"]>;
export type RpcOutput<M extends RpcMethodName> = RpcMethods[M] extends UnaryMethod<TSchema, infer O> ? Static<O> : never;
export type RpcChunk<M extends RpcMethodName> = RpcMethods[M] extends StreamMethod<TSchema, infer C> ? Static<C> : never;
export type UnaryMethodName = { [K in RpcMethodName]: RpcMethods[K]["kind"] extends "unary" ? K : never }[RpcMethodName];
export type StreamMethodName = { [K in RpcMethodName]: RpcMethods[K]["kind"] extends "stream" ? K : never }[RpcMethodName];
