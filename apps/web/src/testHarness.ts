import { vi } from "vitest";
import { emptyReadModel, type EventRecord, type ReadModel } from "@tide/contracts";
import type { ModelStore, ModelStoreState } from "@tide/client";
import { attachModelStore } from "./state/model.ts";
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
