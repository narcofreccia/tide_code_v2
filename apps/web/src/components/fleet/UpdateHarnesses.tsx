import { useEffect, useRef, useState } from "react";
import type { ProviderKind } from "@tide/contracts";
import { stream, type StreamControl } from "../../state/model.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { Button } from "../ui/Button.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";
import styles from "./Environments.module.css";

type Key = ProviderKind | "general";

interface Log {
  lines: string[];
  done: boolean;
  ok?: boolean;
}

const MAX_LINES = 200;

/**
 * "Update harnesses": runs each installed CLI's own update command on this machine and
 * streams the output into one log per harness.
 */
export function UpdateHarnesses() {
  const [logs, setLogs] = useState<Partial<Record<Key, Log>>>({});
  const [running, setRunning] = useState(false);
  const control = useRef<StreamControl | null>(null);
  useEffect(() => () => control.current?.cancel(), []);

  const start = (): void => {
    setLogs({});
    setRunning(true);
    const handle = stream("env.updateHarnesses", {}, (chunk) => {
      const key: Key = chunk.kind ?? "general";
      setLogs((prev) => {
        const log = prev[key] ?? { lines: [], done: false };
        const lines = chunk.line === "" ? log.lines : [...log.lines, chunk.line].slice(-MAX_LINES);
        return {
          ...prev,
          [key]: { lines, done: chunk.done === true || log.done, ...(chunk.ok === undefined ? (log.ok === undefined ? {} : { ok: log.ok }) : { ok: chunk.ok }) },
        };
      });
    });
    control.current = handle;
    handle.done
      .catch((err: unknown) =>
        setLogs((prev) => ({ ...prev, general: { lines: [...(prev.general?.lines ?? []), errorText(err)], done: true, ok: false } })),
      )
      .finally(() => setRunning(false));
  };

  const entries = Object.entries(logs) as [Key, Log][];
  return (
    <SettingRow
      label="Harness CLIs"
      help="Runs each installed CLI's own update command on this machine"
      control={
        <Button disabled={running} onClick={start}>
          {running ? "Updating…" : "Update harnesses"}
        </Button>
      }
      extra={
        entries.length === 0 ? undefined : (
          <div className={styles.logs}>
            {entries.map(([key, log]) => (
              <section key={key} className={styles.log} aria-label={`${key} update log`}>
                <header className={styles.logHead}>
                  <span>{key === "general" ? "updater" : key}</span>
                  <span className={log.ok === false ? styles.bad : log.ok === true ? styles.good : styles.muted}>
                    {!log.done ? "running…" : log.ok === false ? "failed" : "done"}
                  </span>
                </header>
                <pre className={styles.logBody}>{log.lines.join("\n")}</pre>
              </section>
            ))}
          </div>
        )
      }
    />
  );
}
