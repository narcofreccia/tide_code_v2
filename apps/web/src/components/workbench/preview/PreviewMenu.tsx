import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcOutput } from "@tide/contracts";
import { call, useModel } from "../../../state/model.ts";
import { errorText } from "../../../lib/dispatchOrToast.ts";
import { openPreviewTab } from "../../../state/workbench.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { RunPanel } from "../run/RunPanel.tsx";
import { normalizePreviewUrl } from "./PreviewTab.tsx";
import styles from "./Preview.module.css";

type Port = RpcOutput<"ports.list">["ports"][number];

const POLL_MS = 5_000;

export const NO_SERVER = "No dev server detected in this worktree.";
export const SERVER_HELP =
  "Start one in the terminal or ask the agent to run it; Tide finds servers whose working directory is this worktree. Or type any URL.";

/** `3000` → `http://localhost:3000`; anything else as the URL bar takes it. */
export function manualPreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^\d{1,5}$/.test(trimmed) ? `http://localhost:${trimmed}` : normalizePreviewUrl(trimmed);
}

/** Any URL the user types (a server Tide cannot see, another port), opened as the preview tab. */
function ManualUrl({ threadId, close }: { threadId: string; close: () => void }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className={styles.manual}
      title={SERVER_HELP}
      onSubmit={(e) => {
        e.preventDefault();
        const url = manualPreviewUrl(draft);
        if (url === "") return;
        openPreviewTab(threadId, url);
        close();
      }}
    >
      <input
        className={styles.url}
        aria-label="Preview a URL"
        placeholder="http://localhost:3000"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button variant="quiet" type="submit" disabled={draft.trim() === ""}>
        Open
      </Button>
      <p className={styles.help}>{SERVER_HELP}</p>
    </form>
  );
}

/** Listening ports of the thread's terminals and harness, refreshed while the menu is open. */
function PortList({ threadId, close }: { threadId: string; close: () => void }) {
  const [ports, setPorts] = useState<Port[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const projectId = useModel((s) => s.model.threads[threadId]?.projectId);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    call("ports.list", { threadId }).then(
      (result) => {
        if (!live.current) return;
        setPorts(result.ports);
        setError(undefined);
      },
      (failure: unknown) => live.current && setError(errorText(failure)),
    );
  }, [threadId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const body = (() => {
    if (error !== undefined && ports === undefined) return <p className={styles.note}>Could not list ports: {error}</p>;
    if (ports === undefined) return <p className={styles.note}>Looking for dev servers…</p>;
    if (ports.length === 0) {
      return (
        <div className={styles.empty}>
          <div className={styles.emptyLine}>
            <p className={styles.note} title={SERVER_HELP}>
              {NO_SERVER}
            </p>
            <Button variant="quiet" onClick={load}>
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          </div>
          {/* R13: start the project's stack right from here */}
          {projectId === undefined ? null : (
            <div className={styles.run}>
              <RunPanel projectId={projectId} threadId={threadId} />
            </div>
          )}
        </div>
      );
    }
    return <PortItems threadId={threadId} ports={ports} close={close} />;
  })();

  return (
    <div className={styles.picker}>
      <div className={styles.body}>{body}</div>
      <ManualUrl threadId={threadId} close={close} />
    </div>
  );
}

function PortItems({ threadId, ports, close }: { threadId: string; ports: Port[]; close: () => void }) {
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
    <Popover
      label="Preview"
      title="Preview a dev server of this thread"
      variant="quiet"
      align="end"
      panelClassName={styles.panel}
    >
      {(close) => <PortList threadId={threadId} close={close} />}
    </Popover>
  );
}
