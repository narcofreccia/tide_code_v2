import { memo, useState } from "react";
import type { Activity } from "@tide/contracts";
import { formatDuration, formatPayload, shortenPath, toolFilePath, toolGlyph, toolTarget } from "../../lib/activity.ts";
import { resolveLoginCommand, runOrCopy } from "../../lib/providerLogin.ts";
import { useModel } from "../../state/model.ts";
import { providerStatus, useProviders } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { openFileTab } from "../../state/workbench.ts";
import { normalizePastedPath } from "../../lib/mentions.ts";
import { summarizeToolResult } from "../../lib/toolSummary.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useTurnSettled } from "./activities/turnSettled.ts";
import { LiveLabel } from "./LiveLabel.tsx";
import styles from "./ActivityRow.module.css";

/** The fixed 16px status column: a check, a cross, or the live "…" while the call runs. */
function StatusMark({ status, live }: { status: string; live: boolean }) {
  if (live) return <LiveLabel text="…" />;
  if (status === "ok") return <Icon name="check" size={12} label="done" />;
  if (status === "error") return <Icon name="close" size={12} label="failed" />;
  return null;
}

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

/** A raw input/output block with a Copy button: the full text, never a summary. */
function DetailBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <>
      <span className={styles.detailHead}>
        <span className={styles.label}>{label}</span>
        <Button variant="quiet" className={styles.copy} aria-label={`Copy ${label}`} title={copied ? "Copied" : `Copy ${label}`} onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={12} />
        </Button>
      </span>
      <pre className={`${styles.pre} ${styles.prePayload}`}>{text}</pre>
    </>
  );
}

const FULL_TARGET_KEYS = ["file_path", "filePath", "path", "notebook_path", "file", "command", "cmd", "script"];

/** The untruncated path or command (every line) behind the one-line target, for its tooltip. */
function fullToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of FULL_TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** One 24px stream line: `▸ Read src/foo.ts` / `❯ Bash pnpm test ✓ 2.1s`. */
export const ActivityRow = memo(function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const cwd = useModel((s) => s.model.threads[activity.threadId]?.worktreePath);
  const turnSettled = useTurnSettled(activity.turnId);

  if (activity.kind === "info" || activity.kind === "error") {
    return <ErrorActivity activity={activity} />;
  }
  if (activity.kind !== "tool") return null;

  const raw = toolFilePath("input" in activity ? activity.input : undefined);
  const filePath = raw === undefined ? undefined : normalizePastedPath(raw, cwd);
  const target = toolTarget(activity.input);
  // the whole command (all lines) or path, for the tooltip of the one-line target
  const fullTarget = fullToolTarget(activity.input) ?? target;
  // a call still "running" after its turn settled will never report back: no spinner
  const stale = activity.status === "running" && turnSettled;
  const live = activity.status === "running" && !stale;
  const tone = stale ? "" : (styles[activity.status] ?? "");
  const output = activity.output ?? "";
  const input = formatPayload(activity.input);
  // the one readable line after the target: a JSON reply's message, a SendMessage recipient, …
  const result = activity.status === "running" ? undefined : summarizeToolResult(activity.toolName, activity.input, activity.output);
  const line = result?.line && result.line !== target && result.line !== fullTarget && !(filePath !== undefined && result.line === raw) ? result.line : undefined;

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
          {live ? (
            <LiveLabel className={styles.liveName} text={activity.toolName} />
          ) : (
            <span className={styles.name}>{activity.toolName}</span>
          )}
          {filePath === undefined && target ? (
            <span className={`${styles.target} ${line ? styles.targetShrink : ""}`} title={fullTarget}>
              {target}
            </span>
          ) : null}
          {line && filePath === undefined ? (
            <span className={styles.resultLine} title={line}>
              {line}
            </span>
          ) : null}
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
        {line && filePath !== undefined ? (
          <span className={styles.resultLine} title={line}>
            {line}
          </span>
        ) : null}
        {activity.durationMs === undefined ? null : (
          <span className={styles.duration}>{formatDuration(activity.durationMs)}</span>
        )}
        <span className={`${styles.mark} ${tone}`}>{stale ? null : <StatusMark status={activity.status} live={live} />}</span>
      </div>
      {open ? (
        <div className={styles.details}>
          {input ? <DetailBlock label="input" text={input} /> : null}
          {output ? <DetailBlock label="output" text={result?.detail ?? output} /> : null}
        </div>
      ) : null}
    </li>
  );
});
