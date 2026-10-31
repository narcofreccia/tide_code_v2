import { useState } from "react";
import { stackServices } from "@tide/client";
import type { Project, RunProfile, RunRepo, RunService, RunStack } from "@tide/contracts";
import { call } from "../../state/model.ts";
import { setRunStack, useRunProfiles } from "../../state/run.ts";
import { showToast } from "../../state/toast.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Pill } from "../ui/Pill.tsx";
import { RunProfileDialog } from "./RunProfileDialog.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import { SettingText } from "./ui/SettingText.tsx";
import { SettingToggle } from "./ui/SettingToggle.tsx";
import { SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { MiddlePath } from "./ProjectRows.tsx";
import styles from "./ProjectRunSection.module.css";

export const RUN_BLURB =
  "How Tide starts this project's repositories together. Profiles live in each repo (.tide/run.json or a tide-run block in QUICKSTART.md); Tide never edits your .env files.";

export function guidePrompt(profile: RunProfile): string {
  return `Write or update QUICKSTART.md: prerequisites, how to run each service below, troubleshooting. Keep the existing \`\`\`tide-run block exactly as is.\n\n${JSON.stringify(profile, null, 2)}`;
}

/** What is on: the saved selection, else every service not marked `default: false`. */
function currentStack(project: Project, repos: RunRepo[]): RunStack {
  if (project.runStack !== undefined) return project.runStack;
  return { selected: stackServices(repos, project).filter((s) => s.selected).map((s) => s.key), pins: {} };
}

function ServiceRow({ repo, service, project, repos }: { repo: RunRepo; service: RunService; project: Project; repos: RunRepo[] }) {
  const key = `${repo.repoKey}.${service.id}`;
  const stack = currentStack(project, repos);
  const on = stack.selected.includes(key);
  const toggle = (next: boolean): Promise<unknown> =>
    setRunStack(project.id, {
      ...stack,
      selected: next ? [...stack.selected, key] : stack.selected.filter((k) => k !== key),
    });
  const pin = (listen: string, text: string): Promise<unknown> => {
    const pins = { ...stack.pins };
    const pinKey = `${key}.${listen}`;
    const port = Number(text);
    if (text.trim() === "" || !Number.isInteger(port) || port < 1 || port > 65535) delete pins[pinKey];
    else pins[pinKey] = port;
    return setRunStack(project.id, { ...stack, pins });
  };
  return (
    <SettingRow
      id={`setting-run-${key}`}
      label={
        <span className={styles.name}>
          {service.name}
          {service.kind === undefined ? null : <Pill size="sm">{service.kind}</Pill>}
        </span>
      }
      help={<span className={styles.command}>{service.command}</span>}
      control={
        <span className={styles.pins}>
          {service.listens.map((l) =>
            l.how === "fixed" ? (
              <Pill key={l.name} size="sm" title="This port cannot move (for example a Tauri devUrl)">
                {l.name} :{l.port} fixed
              </Pill>
            ) : (
              <SettingText
                key={l.name}
                size="short"
                mono
                label={`${service.name} ${l.name} port pin`}
                placeholder={String(l.port)}
                value={stack.pins[`${key}.${l.name}`]?.toString() ?? ""}
                suffix={l.name}
                validate={(v) => (v.trim() === "" || /^\d{1,5}$/.test(v.trim()) ? undefined : "Port 1–65535")}
                onCommit={(v) => pin(l.name, v.trim())}
              />
            ),
          )}
          <SettingToggle label={`${service.name} in stack`} checked={on} onChange={toggle} />
        </span>
      }
    />
  );
}

type Pending = { kind: "model"; repo: RunRepo } | { kind: "json"; repo: RunRepo } | null;

function RepoGroup({ repo, project, repos, rescan, refresh }: {
  repo: RunRepo;
  project: Project;
  repos: RunRepo[];
  rescan: (repoId: string, useModel: boolean) => Promise<unknown>;
  refresh: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const profile = repo.profile;
  const run = (what: string, fn: () => Promise<unknown>): void => {
    fn().catch((e: unknown) => showToast(`${what} failed: ${errorText(e)}`));
  };
  const writeGuide = (): void =>
    run("Writing QUICKSTART.md", async () => {
      const { path } = await call("run.quickstart.write", { projectId: project.id, repoId: repo.repoId });
      showToast(`Wrote ${path}`);
    });
  const askAgent = (): void => {
    if (profile === undefined) return;
    void navigator.clipboard?.writeText(guidePrompt(profile)).then(
      () => showToast("Prompt copied; paste it in a new thread"),
      () => showToast("Could not copy the prompt"),
    );
  };
  return (
    <SettingsGroup
      label={`Run profile — ${repo.label}`}
      title={
        <span className={styles.repoHead}>
          <span className={styles.repoLabel}>{repo.label}</span>
          <MiddlePath path={repo.path} />
          {profile === undefined ? null : <Pill size="sm">{profile.source}</Pill>}
          {repo.stale ? (
            <Pill size="sm" tone="needs" title="manifests changed since this profile was made">
              stale
            </Pill>
          ) : null}
        </span>
      }
      actions={
        <span className={styles.actions}>
          <Button onClick={() => run("Rescan", () => rescan(repo.repoId, false))}>Rescan</Button>
          <Button onClick={() => setPending({ kind: "model", repo })} title="Uses your text model">
            Ask the model
          </Button>
          <Button disabled={profile === undefined} onClick={() => setPending({ kind: "json", repo })}>
            Edit JSON
          </Button>
          <Button disabled={profile === undefined} onClick={writeGuide}>
            Write QUICKSTART.md
          </Button>
          <Button disabled={profile === undefined} onClick={askAgent}>
            Ask the agent to write the guide
          </Button>
        </span>
      }
    >
      {repo.error === undefined ? null : <SettingNote role="alert">{repo.error}</SettingNote>}
      {profile === undefined && repo.error === undefined ? (
        <SettingNote>No profile yet. Rescan reads the repo's manifests.</SettingNote>
      ) : null}
      {profile?.services.map((s) => <ServiceRow key={s.id} repo={repo} service={s} project={project} repos={repos} />)}
      {profile?.warnings.map((w) => <SettingNote key={w}>{w}</SettingNote>)}
      {pending?.kind === "model" ? (
        <ConfirmDialog
          title="Ask the model"
          body="Sends the repo's manifests and file tree to your text model."
          confirmLabel="Send"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            run("Asking the model", () => rescan(repo.repoId, true));
          }}
        />
      ) : null}
      {pending?.kind === "json" && profile !== undefined ? (
        <RunProfileDialog
          repoLabel={repo.label}
          profile={profile}
          onCancel={() => setPending(null)}
          onSave={async (next) => {
            await call("run.profiles.set", { projectId: project.id, repoId: repo.repoId, profile: next });
            refresh();
          }}
        />
      ) : null}
    </SettingsGroup>
  );
}

/** Settings › Projects › Run stack: per repo profile, which services are in the stack, port pins. */
export function ProjectRunSection({ project, onBack }: { project: Project; onBack: () => void }) {
  const { repos, loading, error, refresh, rescan } = useRunProfiles(project.id);
  return (
    <SettingsPage title={`Run stack — ${project.title}`} blurb={RUN_BLURB}>
      <Button variant="quiet" className={styles.back} onClick={onBack}>
        Back to projects
      </Button>
      {error === undefined ? null : <SettingNote role="alert">{error}</SettingNote>}
      {loading && repos.length === 0 ? <SettingNote role="status">Reading profiles…</SettingNote> : null}
      {repos.map((repo) => (
        <RepoGroup key={repo.repoId} repo={repo} project={project} repos={repos} rescan={rescan} refresh={refresh} />
      ))}
    </SettingsPage>
  );
}
