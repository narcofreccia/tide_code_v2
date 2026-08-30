import { Type, type Static } from "typebox";
import { InteractionMode, ProviderKind, RuntimeMode } from "./domain.ts";

// Commands = validated intents sent by clients (or by server reactors).
// The decider turns a command into zero or more events, or rejects it.

export const ProjectCreate = Type.Object({
  type: Type.Literal("project.create"),
  title: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 }),
});
export const ProjectUpdate = Type.Object({
  type: Type.Literal("project.update"),
  projectId: Type.String(),
  title: Type.Optional(Type.String({ minLength: 1 })),
});
export const ProjectArchive = Type.Object({
  type: Type.Literal("project.archive"),
  projectId: Type.String(),
});

export const ThreadCreate = Type.Object({
  type: Type.Literal("thread.create"),
  projectId: Type.String(),
  parentThreadId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  provider: ProviderKind,
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
});
export const ThreadUpdate = Type.Object({
  type: Type.Literal("thread.update"),
  threadId: Type.String(),
  title: Type.Optional(Type.String()),
  provider: Type.Optional(ProviderKind),
  model: Type.Optional(Type.String()),
  mode: Type.Optional(RuntimeMode),
  interaction: Type.Optional(InteractionMode),
});
export const ThreadArchive = Type.Object({
  type: Type.Literal("thread.archive"),
  threadId: Type.String(),
});

/** P1: user sends a prompt. Recorded now so the schema is stable. */
export const TurnRequest = Type.Object({
  type: Type.Literal("turn.request"),
  threadId: Type.String(),
  text: Type.String({ minLength: 1 }),
});

export const Command = Type.Union([
  ProjectCreate,
  ProjectUpdate,
  ProjectArchive,
  ThreadCreate,
  ThreadUpdate,
  ThreadArchive,
  TurnRequest,
]);
export type Command = Static<typeof Command>;
export type CommandOf<T extends Command["type"]> = Extract<Command, { type: T }>;
