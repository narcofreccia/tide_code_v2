import { useEffect, useState } from "react";
import type { RpcOutput } from "@tide/contracts";
import { call } from "../../../state/model.ts";
import { errorText } from "../../../lib/dispatchOrToast.ts";
import { openPreviewTab } from "../../../state/workbench.ts";
import { Button } from "../../ui/Button.tsx";
import { Popover } from "../../ui/Popover.tsx";
import styles from "./Preview.module.css";

type Port = RpcOutput<"ports.list">["ports"][number];

const POLL_MS = 5_000;

/** Listening ports of the thread's terminals and harness, refreshed while the menu is open. */
function PortList({ threadId, close }: { threadId: string; close: () => void }) {
  const [ports, setPorts] = useState<Port[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      call("ports.list", { threadId }).then(
        (result) => {
          if (!live) return;
          setPorts(result.ports);
          setError(undefined);
        },
        (failure: unknown) => live && setError(errorText(failure)),
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId]);

  if (error !== undefined && ports === undefined) return <p className={styles.note}>Could not list ports: {error}</p>;
  if (ports === undefined) return <p className={styles.note}>Looking for dev servers…</p>;
  if (ports.length === 0) return <p className={styles.note}>No dev server detected — start one in the terminal</p>;
  return (
    <div className={styles.ports} role="menu" aria-label="Dev servers">
      {ports.map((port) => (
        <Button
          key={`${port.port}-${port.pid}`}
          variant="quiet"
          role="menuitem"
          title={`${port.command} (pid ${port.pid})`}
          onClick={() => {
            openPreviewTab(threadId, port.url);
            close();
          }}
        >
          <span className={styles.port}>:{port.port}</span>
          <span className={styles.command}>{port.command}</span>
        </Button>
      ))}
    </div>
  );
}

/** "Preview" in the workbench header: pick a running dev server to open as a tab. */
export function PreviewMenu({ threadId }: { threadId: string }) {
  return (
    <Popover label="Preview" title="Preview a dev server of this thread" variant="quiet" align="end">
      {(close) => <PortList threadId={threadId} close={close} />}
    </Popover>
  );
}
