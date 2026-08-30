import { vi } from "vitest";
import {
  emptyReadModel,
  type Activity,
  type ActivityOf,
  type EventRecord,
  type ProposedPlan,
  type ReadModel,
  type Thread,
} from "@tide/contracts";
import type { ModelStore, ModelStoreState } from "@tide/client";
import { attachModelStore } from "./state/model.ts";
import { resetProviders } from "./state/providers.ts";
import { useUi } from "./state/ui.ts";

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

export function resetUi(): void {
  resetProviders();
  useUi.setState({
    view: "mission",
    selectedProjectId: null,
    selectedThreadId: null,
    newProjectOpen: false,
    focusMode: "split",
    railCollapsed: false,
    splitRatio: 0.45,
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
