import { vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  emptyReadModel,
  type Activity,
  type ActivityOf,
  type EventRecord,
  type ExpertsFinding,
  type ExpertsMessage,
  type ExpertsSession,
  type ProposedPlan,
  type Message,
  type ReadModel,
  type Thread,
  type Turn,
  type StreamMethodName,
  type UnaryMethodName,
} from "@tide/contracts";
import type { ModelStore, ModelStoreState } from "@tide/client";
import {
  attachModelStore,
  setRpcCaller,
  setRpcStreamer,
  type RpcCaller,
  type RpcStreamer,
  type StreamControl,
} from "./state/model.ts";
import { resetProviders } from "./state/providers.ts";
import { useUi } from "./state/ui.ts";
import { resetVcs } from "./state/vcs.ts";
import { resetFiles } from "./state/files.ts";
import { resetDocs } from "./state/docs.ts";
import { resetWorkbench } from "./state/workbench.ts";
import { resetTerminals } from "./state/terminals.ts";
import { resetSearch } from "./state/search.ts";
import { resetSettings } from "./state/settings.ts";

export interface FakeStore {
  store: ModelStore;
  dispatch: ReturnType<typeof vi.fn>;
  detach: () => void;
}

/** Attaches a stubbed client store so components can render without a server. */
export function attachFakeStore(model: ReadModel): FakeStore {
  const state: ModelStoreState = { model, status: "open", lastError: null };
  const dispatch = vi.fn(async (): Promise<{ seq: number; events: EventRecord[] }> => ({
    seq: 0,
    events: [],
  }));
  const store: ModelStore = {
    getState: () => state,
    subscribe: () => () => undefined,
    dispatch: dispatch as unknown as ModelStore["dispatch"],
    dispose: () => undefined,
  };
  const detach = attachModelStore(store);
  return { store, dispatch, detach };
}

/**
 * Drives the custom listbox `Select`: opens the combobox named `label` and
 * clicks the option named `option`. Tests used to `fireEvent.change` a native
 * `<select>`; this is the one-line replacement.
 */
export function chooseOption(label: string, option: string | RegExp): void {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox", { name: label });
  fireEvent.click(within(listbox).getByRole("option", { name: option }));
}

/** The option labels a `Select` offers, in order. */
export function optionLabels(label: string): string[] {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox", { name: label });
  const labels = within(listbox)
    .getAllByRole("option")
    .map((node) => node.textContent?.replace(/✓$/, "").trim() ?? "");
  fireEvent.keyDown(listbox, { key: "Escape" });
  return labels;
}

export function resetUi(): void {
  resetProviders();
  resetVcs();
  resetFiles();
  resetDocs();
  resetWorkbench();
  resetTerminals();
  resetSearch();
  resetSettings();
  setRpcCaller(undefined);
  setRpcStreamer(undefined);
  window.localStorage.clear();
  useUi.setState({
    view: "mission",
    selectedProjectId: null,
    selectedThreadId: null,
    selectedExpertsSessionId: null,
    expertsReturnTo: "mission",
    newExpertsProjectId: null,
    newProjectOpen: false,
    linksProjectId: null,
    paletteOpen: false,
    threadDialog: null,
    focusMode: "split",
    railCollapsed: false,
    splitRatio: 0.45,
    diffSideBySide: true,
    fileListCollapsed: false,
    settingsSection: "providers",
    settingsReturnTo: "mission",
  });
}

export function modelWith(patch: Partial<ReadModel>): ReadModel {
  return { ...emptyReadModel(), ...patch };
}

// ---- fixtures ----

export function makeThread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: `Thread ${id}`,
    provider: "claude",
    mode: "approval-required",
    interaction: "default",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

export function makeTool(id: string, patch: Partial<ActivityOf<"tool">> = {}): ActivityOf<"tool"> {
  return {
    id,
    threadId: "t1",
    turnId: "u1",
    createdAt: 1,
    updatedAt: 1,
    kind: "tool",
    toolUseId: `use-${id}`,
    toolName: "Read",
    input: { file_path: "/repo/src/foo.ts" },
    status: "ok",
    ...patch,
  };
}

export function makeApproval(id: string, patch: Partial<ActivityOf<"approval">> = {}): ActivityOf<"approval"> {
  return {
    id,
    threadId: "t1",
    turnId: "u1",
    createdAt: 1,
    updatedAt: 1,
    kind: "approval",
    requestId: `req-${id}`,
    toolName: "Edit",
    input: { file_path: "/repo/src/x.ts" },
    status: "pending",
    ...patch,
  };
}

export function makeUserInput(
  id: string,
  questions: ActivityOf<"user-input">["questions"],
  patch: Partial<ActivityOf<"user-input">> = {},
): ActivityOf<"user-input"> {
  return {
    id,
    threadId: "t1",
    turnId: "u1",
    createdAt: 1,
    updatedAt: 1,
    kind: "user-input",
    requestId: `req-${id}`,
    questions,
    status: "pending",
    ...patch,
  };
}

export function makePlan(id: string, patch: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    id,
    threadId: "t1",
    turnId: "u1",
    markdown: "## Plan\n\n1. do the thing",
    status: "proposed",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** Builds a one-thread model whose timeline holds the given activities/plans. */
export function modelWithTimeline(thread: Thread, entries: (Activity | ProposedPlan)[]): ReadModel {
  const model = modelWith({ threads: { [thread.id]: thread } });
  model.threadMessages[thread.id] = [];
  model.threadTimeline[thread.id] = entries.map((entry) =>
    "kind" in entry
      ? { kind: "activity" as const, id: entry.id }
      : { kind: "plan" as const, id: entry.id },
  );
  for (const entry of entries) {
    if ("kind" in entry) model.activities[entry.id] = entry;
    else model.plans[entry.id] = entry;
  }
  return model;
}

/** Answers non-command RPC from a table; unmocked methods reject loudly. */
export function mockRpc(handlers: Partial<Record<UnaryMethodName, (params: never) => unknown>>) {
  const caller = vi.fn(async (method: string, params: unknown) => {
    const handler = handlers[method as UnaryMethodName] as ((p: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unmocked rpc: ${method}`);
    return handler(params);
  });
  setRpcCaller(caller as unknown as RpcCaller);
  return caller;
}

export function makeTurn(id: string, patch: Partial<Turn> = {}): Turn {
  return { id, threadId: "t1", status: "completed", requestedAt: 1, ...patch };
}

export function makeMessage(id: string, patch: Partial<Message> = {}): Message {
  return { id, threadId: "t1", turnId: "u1", role: "user", text: "hello", createdAt: 1, ...patch };
}

/** One thread with its turns and messages wired into the read model. */
export function modelWithTurns(thread: Thread, turns: Turn[], messages: Message[] = []): ReadModel {
  const model = modelWith({ threads: { [thread.id]: thread } });
  for (const turn of turns) model.turns[turn.id] = turn;
  for (const message of messages) model.messages[message.id] = message;
  model.threadMessages[thread.id] = messages.map((m) => m.id);
  model.threadTimeline[thread.id] = messages.map((m) => ({ kind: "message" as const, id: m.id }));
  return model;
}

// ---- streaming RPC ----

export interface FakeStream {
  method: StreamMethodName;
  params: unknown;
  /** pushes one chunk to the subscriber */
  push: (chunk: unknown) => void;
  cancelled: boolean;
}

/** Records every `stream()` call and hands the test a way to push chunks. */
export function mockStream(): { streams: FakeStream[]; streamer: RpcStreamer } {
  const streams: FakeStream[] = [];
  const streamer = ((method: StreamMethodName, params: unknown, onChunk: (chunk: unknown) => void): StreamControl => {
    const entry: FakeStream = { method, params, push: onChunk, cancelled: false };
    streams.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
      done: Promise.resolve(),
    };
  }) as unknown as RpcStreamer;
  setRpcStreamer(streamer);
  return { streams, streamer };
}

// ---- experts fixtures ----

export function makeExpertsSession(id: string, patch: Partial<ExpertsSession> = {}): ExpertsSession {
  return {
    id,
    projectId: "p1",
    topic: "How should we shard the index?",
    phase: "exploring",
    experts: [
      { key: "architect", name: "Architect", role: "system design", provider: "claude", status: "working" },
      { key: "security", name: "Security", role: "threat modelling", provider: "codex", status: "idle" },
    ],
    lead: { provider: "claude" },
    findingIds: [],
    messageIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

export function makeFinding(id: string, patch: Partial<ExpertsFinding> = {}): ExpertsFinding {
  return { id, sessionId: "x1", author: "architect", text: "the seam is the index writer", createdAt: 2, ...patch };
}

export function makeExpertsMessage(id: string, patch: Partial<ExpertsMessage> = {}): ExpertsMessage {
  return { id, sessionId: "x1", from: "security", to: "all", text: "what signs the shard map?", createdAt: 3, ...patch };
}

/** A read model holding one session with its findings, messages and threads. */
export function modelWithExperts(
  session: ExpertsSession,
  findings: ExpertsFinding[] = [],
  messages: ExpertsMessage[] = [],
  threads: Thread[] = [],
): ReadModel {
  const model = modelWith({ expertsSessions: { [session.id]: session } });
  for (const finding of findings) model.expertsFindings[finding.id] = finding;
  for (const message of messages) model.expertsMessages[message.id] = message;
  for (const thread of threads) model.threads[thread.id] = thread;
  model.expertsSessions[session.id] = {
    ...session,
    findingIds: findings.map((f) => f.id),
    messageIds: messages.map((m) => m.id),
  };
  return model;
}

/** Makes the fake dispatch answer with the events a real engine would have appended. */
export function replyWithEvents(fake: FakeStore, events: EventRecord["event"][]): void {
  fake.dispatch.mockResolvedValue({
    seq: events.length,
    events: events.map((event, i) => ({ seq: i + 1, ts: 1, event })),
  });
}
