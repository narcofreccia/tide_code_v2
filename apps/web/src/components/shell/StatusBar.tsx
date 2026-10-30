import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useShownThread } from "../../state/hooks.ts";
import { contextTitle, formatUsd } from "../../lib/glassBox.ts";
import { shortInstanceLabel, tightestInstance, windowsText } from "../../lib/limits.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { resolveServerUrl } from "../../lib/bootstrap.ts";
import { threadStateLabel } from "../../lib/vocab.ts";
import { ConnectionDot } from "../ui/ConnectionDot.tsx";
import { PrBadge } from "../ui/VcsBadges.tsx";
import { useSelectedDiffStats, useVcsStatus } from "../../state/vcs.ts";
import { useWorkbench } from "../../state/workbench.ts";
import styles from "./StatusBar.module.css";

const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  closed: "disconnected",
};

/** `ctx 41% · $0.82` — the glass-box numbers, only when the harness reports them. */
function ThreadStats({ thread }: { thread: Thread }) {
  const context = thread.contextUsage;
  const percent = context && context.window > 0 ? Math.round((context.used / context.window) * 100) : undefined;
  const cost = thread.totalCostUsd;
  if (percent === undefined && cost === undefined) return null;
  return (
    <span className={styles.item} {...(context && percent !== undefined ? { title: contextTitle(context) } : {})}>
      {percent === undefined ? null : `ctx ${percent}%`}
      {percent !== undefined && cost !== undefined ? " · " : ""}
      {cost === undefined ? null : formatUsd(cost)}
    </span>
  );
}

/** `⎇ branch (worktree)` + the selected turn's diff stats + the PR chip. */
function GitStatus({ thread }: { thread: Thread }) {
  // worktree threads carry their branch in the read model; others need git.
  const status = useVcsStatus(thread.worktreePath === undefined ? thread.id : undefined);
  const stats = useSelectedDiffStats(thread.id);
  const branch = thread.branch ?? status.data?.branch;
  const onWorktree = thread.worktreePath !== undefined || status.data?.worktree === true;

  return (
    <>
      {branch ? (
        <span className={styles.item} title={thread.worktreePath ?? status.data?.cwd ?? branch}>
          ⎇ {branch}
          {onWorktree ? " (worktree)" : ""}
        </span>
      ) : null}
      {stats ? (
        <span className={styles.item}>
          <span className={styles.add}>+{stats.additions}</span>
          <span className={styles.del}>−{stats.deletions}</span>
        </span>
      ) : null}
      {thread.pr ? <PrBadge pr={thread.pr} /> : null}
    </>
  );
}

/** `Ln 12, Col 4 · TypeScript` for the file the workbench is editing. */
function EditorPosition({ threadId }: { threadId: string }) {
  const status = useWorkbench((s) => s.editorStatus);
  if (!status || status.threadId !== threadId) return null;
  return (
    <span className={styles.item}>
      Ln {status.line}, Col {status.column} · {status.language}
    </span>
  );
}

/**
 * `Claude 5h 62% · wk 18%`: the harness closest to its limit, share of each window used.
 * Always on when Settings › Glass box says so; a click opens the Usage page.
 */
export function LimitsItem() {
  const on = useServerSettings((s) => s.settings.glassBox.limitsInStatusBar);
  const model = useModel((s) => s.model);
  const providers = useProvidersSnapshot();
  const showUsage = useUi((s) => s.showUsage);
  if (!on) return null;
  const entry = tightestInstance(model);
  if (!entry) return null;
  const windows = windowsText(entry);
  if (windows === "") return null;
  const text = `${shortInstanceLabel(providers, entry.id)} ${windows}`;
  return (
    <button
      type="button"
      className={`${styles.item} ${styles.limits}`}
      onClick={showUsage}
      title={`${text}: share of each window used, as the harness last reported it. Open Usage`}
    >
      {text}
    </button>
  );
}

/** The server's host:port, shown on hover only. */
function serverHost(): string {
  try {
    return new URL(resolveServerUrl()).host;
  } catch {
    return "";
  }
}

export function StatusBar() {
  const status = useModel((s) => s.status);
  const lastError = useModel((s) => s.lastError);
  const thread = useShownThread();

  return (
    <footer className={styles.bar}>
      <span className={styles.item} title={serverHost()}>
        <ConnectionDot status={status} />
        {LABEL[status] ?? status}
      </span>
      {thread ? (
        <span className={styles.item}>
          thread: {threadStateLabel(thread)}
        </span>
      ) : null}
      {thread ? <ThreadStats thread={thread} /> : null}
      {thread ? <GitStatus thread={thread} /> : null}
      {thread ? <EditorPosition threadId={thread.id} /> : null}
      <LimitsItem />
      {lastError ? <span className={styles.error}>{lastError}</span> : null}
    </footer>
  );
}
