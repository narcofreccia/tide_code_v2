import type { InteractionMode, ProviderKind, RuntimeMode } from "@tide/contracts";
import { dispatch } from "../state/model.ts";
import { useUi } from "../state/ui.ts";

export interface ThreadPatch {
  title?: string;
  provider?: ProviderKind;
  mode?: RuntimeMode;
  interaction?: InteractionMode;
}

export function updateThread(threadId: string, patch: ThreadPatch): void {
  void dispatch({ type: "thread.update", threadId, ...patch }).catch(() => undefined);
}

export function archiveThread(threadId: string): void {
  void dispatch({ type: "thread.archive", threadId }).catch(() => undefined);
  useUi.getState().selectThread(null);
}

/** Creates a thread (optionally as a child) and selects it. */
export async function createThread(
  projectId: string,
  provider: ProviderKind,
  parentThreadId?: string,
): Promise<void> {
  const result = await dispatch({
    type: "thread.create",
    projectId,
    provider,
    title: "New thread",
    ...(parentThreadId ? { parentThreadId } : {}),
  });
  const created = result.events.find((r) => r.event.type === "thread.created");
  if (created && created.event.type === "thread.created") {
    useUi.getState().selectThread(created.event.thread.id);
  }
}

export async function sendTurn(threadId: string, text: string): Promise<void> {
  await dispatch({ type: "turn.request", threadId, text });
}
