import { useEffect } from "react";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { DEFAULT_WORKTREE_ROOT } from "../../state/settings.ts";
import { setWorktreeByDefault, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { ensureStatus, useVcs } from "../../state/vcs.ts";
import { Checkbox } from "../ui/Choice.tsx";
import section from "./Section.module.css";

function ghNote(hasGh: boolean | undefined): string {
  if (hasGh === undefined) return "Select a thread to check whether `gh` is available in its worktree.";
  return hasGh
    ? "`gh` detected — Publish commits, pushes and opens the PR."
    : "`gh` not found — install GitHub CLI to open PRs from Tide.";
}

/** Where worktrees live, the server-side new-thread default, and `gh` detection. */
export function GitSection() {
  const threadId = useUi((s) => s.selectedThreadId);
  const status = useVcs((s) => (threadId ? s.statuses[threadId]?.data : undefined));
  const info = useServerInfo();
  const worktreeByDefault = useServerSettings((s) => s.settings.worktreeByDefault);

  useEffect(() => {
    if (threadId) ensureStatus(threadId);
  }, [threadId]);

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Git</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Worktree root</span>
          <span className={section.value}>{info?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT}</span>
        </li>
        <li className={section.row}>
          <Checkbox
            className={section.check}
            checked={worktreeByDefault}
            onChange={(event) => void setWorktreeByDefault(event.target.checked)}
          >
            Create a worktree for new threads by default
          </Checkbox>
        </li>
        <li className={section.row}>
          <span className={section.label}>Current thread</span>
          <span className={section.value}>{status ? status.cwd : "—"}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Pull requests</span>
          <span className={section.note}>{ghNote(status?.hasGh)}</span>
        </li>
      </ul>
    </div>
  );
}
