import { useEffect } from "react";
import type { UserSettings } from "@tide/contracts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { DEFAULT_WORKTREE_ROOT } from "../../state/settings.ts";
import { defaultGitSettings, patchServerSettings, setWorktreeByDefault, useSelectedSettings } from "../../state/serverSettings.ts";
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
type PushThreadBranches = UserSettings["git"]["pushThreadBranches"];

const STRATEGIES: { value: MergeStrategy; label: string }[] = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
];

const PUSH_OPTIONS: { value: PushThreadBranches; label: string; description: string }[] = [
  { value: "never", label: "Never", description: "Thread branches stay on this machine until you publish" },
  { value: "on-checkpoint", label: "After every turn", description: "Push the committed branch after each turn, for review elsewhere" },
  { value: "on-merge-request", label: "When merging back", description: "Commit and push the branch once, right before it merges" },
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
    "Push thread branches to origin",
    "Sync the base branch with origin",
    "Generate commit and PR messages",
    "push",
    "pull",
    "origin",
    "squash",
    "rebase",
    "gh",
  ],
  perEnvironment: true,
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
  const worktreeByDefault = useSelectedSettings((s) => s.settings.worktreeByDefault);
  // a server older than the merge-back settings answers without `git`
  const stored = useSelectedSettings((s) => s.settings.git);
  // R17 fields default for a server that predates them
  const git = { ...defaultGitSettings(), ...stored };

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
      <SettingsGroup title="Remote">
        <SettingRow
          label="Push thread branches to origin"
          help={PUSH_OPTIONS.find((o) => o.value === git.pushThreadBranches)?.description}
          control={
            <SettingSelect
              label="Push thread branches to origin"
              value={git.pushThreadBranches}
              options={PUSH_OPTIONS}
              onSelect={(pushThreadBranches) => patchGit({ pushThreadBranches })}
            />
          }
        />
        <SettingRow
          label="Sync the base branch with origin"
          help="Before a merge back, fast-forward the base from origin (a stale or diverged base is refused); after it, push the base"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={git.syncBaseWithRemote}
              onChange={(syncBaseWithRemote) => patchGit({ syncBaseWithRemote })}
            />
          )}
        />
      </SettingsGroup>
      <SettingsGroup title="Messages">
        <SettingRow
          label="Generate commit and PR messages"
          help="Squash merges, and publishes without a title, get their commit and PR text from the text model; otherwise Tide uses the thread title"
          control={(id) => (
            <SettingToggle
              id={id}
              checked={git.generateMessages}
              onChange={(generateMessages) => patchGit({ generateMessages })}
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
