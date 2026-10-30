import { useEffect } from "react";
import type { UserSettings } from "@tide/contracts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { DEFAULT_WORKTREE_ROOT } from "../../state/settings.ts";
import { defaultGitSettings, patchServerSettings, setWorktreeByDefault, useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { ensureStatus, useVcs } from "../../state/vcs.ts";
import type { SectionMeta } from "./search.ts";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingSelect } from "./ui/SettingSelect.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";
import styles from "./ui/settings.module.css";

type MergeStrategy = UserSettings["git"]["mergeStrategy"];

const STRATEGIES: { value: MergeStrategy; label: string }[] = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
];

export const META: SectionMeta = {
  title: "Git",
  blurb: "Where worktrees live, what new threads get, and how a thread's branch goes back into its base.",
  keywords: [
    "Worktree root",
    "Create a worktree for new threads by default",
    "Current thread",
    "Merge back strategy",
    "Delete the branch after merging",
    "Ask before merging back from the inbox",
    "Pull requests",
    "squash",
    "rebase",
    "gh",
  ],
};

function ghNote(hasGh: boolean | undefined): string {
  if (hasGh === undefined) return "Select a thread to check whether `gh` is available in its worktree.";
  return hasGh
    ? "`gh` detected: Publish commits, pushes and opens the PR."
    : "`gh` not found: install GitHub CLI to open PRs from Tide.";
}

function patchGit(git: Partial<UserSettings["git"]>): Promise<void> {
  return patchServerSettings({ git });
}

/** Where worktrees live, the server-side new-thread default, merge-back defaults and `gh` detection. */
export function GitSection() {
  const threadId = useUi((s) => s.selectedThreadId);
  const status = useVcs((s) => (threadId ? s.statuses[threadId]?.data : undefined));
  const info = useServerInfo();
  const worktreeByDefault = useServerSettings((s) => s.settings.worktreeByDefault);
  // a server older than the merge-back settings answers without `git`
  const git = useServerSettings((s) => s.settings.git) ?? defaultGitSettings();

  useEffect(() => {
    if (threadId) ensureStatus(threadId);
  }, [threadId]);

  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Worktrees">
        <SettingRow
          label="Worktree root"
          control={<span className={styles.value}>{info?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT}</span>}
        />
        <SettingRow
          label="Create a worktree for new threads by default"
          control={(id) => <SettingToggle id={id} checked={worktreeByDefault} onChange={setWorktreeByDefault} />}
        />
        <SettingRow label="Current thread" control={<span className={styles.value}>{status ? status.cwd : "—"}</span>} />
      </SettingsGroup>
      <SettingsGroup title="Merge back">
        <SettingRow
          label="Merge back strategy"
          help="Used when you merge a thread's branch into its base without a pull request"
          control={
            <SettingSelect
              label="Merge back strategy"
              value={git.mergeStrategy}
              options={STRATEGIES}
              onSelect={(mergeStrategy) => patchGit({ mergeStrategy })}
            />
          }
        />
        <SettingRow
          label="Delete the branch after merging"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={git.deleteBranchOnMerge}
              onChange={(deleteBranchOnMerge) => patchGit({ deleteBranchOnMerge })}
            />
          )}
        />
        <SettingRow
          label="Ask before merging back from the inbox"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={git.confirmMergeBack}
              onChange={(confirmMergeBack) => patchGit({ confirmMergeBack })}
            />
          )}
        />
      </SettingsGroup>
      <SettingsGroup title="Pull requests">
        <SettingRow label="Pull requests" help={ghNote(status?.hasGh)} />
      </SettingsGroup>
    </SettingsPage>
  );
}
