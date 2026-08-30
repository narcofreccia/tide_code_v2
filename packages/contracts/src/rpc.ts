import { Type, type Static, type TSchema } from "typebox";
import { ClientCommand } from "./commands.ts";
import { EventRecord } from "./events.ts";
import { ProviderKind, ReadModel } from "./domain.ts";

// ---- wire envelope ----
// client -> server
export const RpcRequest = Type.Object({ id: Type.String(), method: Type.String(), params: Type.Unknown() });
export type RpcRequest = Static<typeof RpcRequest>;
// server -> client (exactly one of result/error/chunk/end per frame)
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
  models: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), family: Type.Optional(Type.String()), default: Type.Optional(Type.Boolean()) })),
  caps: Type.Object({
    planMode: Type.Boolean(), subagents: Type.Boolean(), mcp: Type.Boolean(), images: Type.Boolean(),
    resume: Type.Boolean(), contextUsage: Type.Boolean(), openInTerminal: Type.Boolean(),
  }),
});
export type ProviderStatusDto = Static<typeof ProviderStatusDto>;

export const ServerInfo = Type.Object({
  environmentId: Type.String(),
  version: Type.String(),
  startedAt: Type.Number(),
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
} as const;

export type RpcMethods = typeof rpcMethods;
export type RpcMethodName = keyof RpcMethods;
export type RpcInput<M extends RpcMethodName> = Static<RpcMethods[M]["input"]>;
export type RpcOutput<M extends RpcMethodName> = RpcMethods[M] extends UnaryMethod<TSchema, infer O> ? Static<O> : never;
export type RpcChunk<M extends RpcMethodName> = RpcMethods[M] extends StreamMethod<TSchema, infer C> ? Static<C> : never;
export type UnaryMethodName = { [K in RpcMethodName]: RpcMethods[K]["kind"] extends "unary" ? K : never }[RpcMethodName];
export type StreamMethodName = { [K in RpcMethodName]: RpcMethods[K]["kind"] extends "stream" ? K : never }[RpcMethodName];
