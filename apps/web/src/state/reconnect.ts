import type { ConnectionStatus } from "@tide/client";
import { useModel } from "./model.ts";
import { showToast } from "./toast.ts";

type Handler = () => void;

const handlers = new Set<Handler>();

/** the app has been connected at least once, so a later `open` is a *re*-connect */
let everOpen = useModel.getState().status === "open";
let last = useModel.getState().status;

/**
 * Runs when the socket comes back after a drop. Long-lived server streams
 * (`fs.watch`, `pty.attach`) die with the connection and are not resumed by the
 * connection layer, so every owner re-creates its own here.
 */
export function onReconnect(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function onStatus(status: ConnectionStatus): void {
  const previous = last;
  last = status;
  if (status !== "open") return;
  if (!everOpen) {
    everOpen = true;
    return;
  }
  if (previous === "open") return;
  showToast("Reconnected");
  for (const handler of [...handlers]) handler();
}

useModel.subscribe((state, prev) => {
  if (state.status !== prev.status) onStatus(state.status);
});

/** Test seam: forgets the connection history, keeping registered handlers. */
export function resetReconnect(): void {
  everOpen = useModel.getState().status === "open";
  last = useModel.getState().status;
}
