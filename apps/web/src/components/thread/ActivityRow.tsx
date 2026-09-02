import { useState } from "react";
import type { Activity } from "@tide/contracts";
import { formatDuration, formatPayload, shortenPath, toolFilePath, toolGlyph, toolTarget } from "../../lib/activity.ts";
import { resolveLoginCommand, runOrCopy } from "../../lib/providerLogin.ts";
import { useModel } from "../../state/model.ts";
import { providerStatus, useProviders } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { openFileTab } from "../../state/workbench.ts";
import { normalizePastedPath } from "../../lib/mentions.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./ActivityRow.module.css";

const MARK: Record<string, string> = { ok: "✓", error: "✕", running: "…" };

/** A harness that refuses because nobody is logged in says so in these words. */
const AUTH_ERROR = /401|not logged in|unauthenticated|login/i;

/** The two plain-text lines: `info` and `error` share one activity shape. */
type NoteActivity = Extract<Activity, { kind: "info" | "error" }>;

/**
 * An error line the user can act on: an auth failure is a login problem, not a
 * mystery, so it offers the settings page and — when the driver told us the
 * command — running the harness's own login right here.
 */
function ErrorActivity({ activity }: { activity: NoteActivity }) {
  const [open, setOpen] = useState(false);
  const isError = activity.kind === "error";
  const provider = useModel((s) => s.model.threads[activity.threadId]?.provider);
  const providers = useProviders();
  const showSettings = useUi((s) => s.showSettings);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  const auth = isError && AUTH_ERROR.test(activity.text);
  const command = auth && provider ? resolveLoginCommand(providerStatus(providers, provider)) : undefined;
  // Anything the harness emitted that Tide does not model rides along raw, so it
  // is shown rather than dropped.
  const payload = activity.payload === undefined ? "" : formatPayload(activity.payload);

  return (
    <li className={styles.item}>
      <div className={`${styles.row} ${isError ? styles.error : styles.info}`}>
        <span className={styles.glyph}>{isError ? "✕" : "·"}</span>
        {payload ? (
          <button
            type="button"
            className={`${styles.rowBare} ${styles.target}`}
            aria-expanded={open}
            aria-label={activity.text}
            onClick={() => setOpen((v) => !v)}
          >
            {activity.text}
          </button>
        ) : (
          <span className={styles.target}>{activity.text}</span>
        )}
        {auth ? (
          <Button
            variant="quiet"
            onClick={() => {
              setSettingsSection("providers");
              showSettings();
            }}
          >
            Open Settings › Providers
          </Button>
        ) : null}
        {command ? (
          <Button variant="quiet" title={command} onClick={() => void runOrCopy(command)}>
            Run login
          </Button>
        ) : null}
      </div>
      {open && payload ? (
        <div className={styles.details}>
          <span className={styles.label}>payload</span>
          <pre className={styles.pre}>{payload}</pre>
        </div>
      ) : null}
    </li>
  );
}

/** One 24px stream line: `▸ Read src/foo.ts` / `❯ Bash pnpm test ✓ 2.1s`. */
export function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const cwd = useModel((s) => s.model.threads[activity.threadId]?.worktreePath);

  if (activity.kind === "info" || activity.kind === "error") {
    return <ErrorActivity activity={activity} />;
  }
  if (activity.kind !== "tool") return null;

  const raw = toolFilePath("input" in activity ? activity.input : undefined);
  const filePath = raw === undefined ? undefined : normalizePastedPath(raw, cwd);
  const target = toolTarget(activity.input);
  const tone = styles[activity.status] ?? "";
  const output = activity.output ?? "";
  const input = formatPayload(activity.input);

  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.rowBare}
          aria-expanded={open}
          aria-label={`${activity.toolName}${target ? ` ${target}` : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`${styles.glyph} ${tone}`}>{toolGlyph(activity.toolName)}</span>
          <span className={styles.name}>{activity.toolName}</span>
          {filePath === undefined ? <span className={styles.target}>{target}</span> : null}
        </button>
        {filePath === undefined ? null : (
          <button
            type="button"
            className={`${styles.target} ${styles.fileLink}`}
            title={`Open ${filePath}`}
            onClick={() => openFileTab(activity.threadId, filePath)}
          >
            {shortenPath(filePath)}
          </button>
        )}
        <span className={`${styles.mark} ${tone}`}>{MARK[activity.status] ?? ""}</span>
        {activity.durationMs === undefined ? null : (
          <span className={styles.duration}>{formatDuration(activity.durationMs)}</span>
        )}
      </div>
      {open ? (
        <div className={styles.details}>
          {input ? (
            <>
              <span className={styles.label}>input</span>
              <pre className={styles.pre}>{input}</pre>
            </>
          ) : null}
          {output ? (
            <>
              <span className={styles.label}>output</span>
              <pre className={styles.pre}>{output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
