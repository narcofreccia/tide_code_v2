import type { ServerInfo } from "@tide/contracts";
import { copyText } from "../../lib/threadActions.ts";
import { envOfProject, useEnvironments } from "../../state/environments.ts";
import { Button } from "../ui/Button.tsx";
import { envHttpOrigin, httpOriginOf } from "./envView.ts";
import styles from "./WebhookUrls.module.css";

/**
 * `<relay client URL>/hook/<id>`: the relay's client URL is a socket or page URL for this
 * machine; its path (minus a trailing `/ws`) is kept so the relay can tell machines apart.
 */
export function relayHookUrl(clientUrl: string, hookId: string): string | undefined {
  const origin = httpOriginOf(clientUrl);
  if (origin === undefined) return undefined;
  const path = new URL(clientUrl).pathname.replace(/\/ws\/?$/, "").replace(/\/$/, "");
  return `${origin}${path}/hook/${hookId}`;
}

export function directHookUrl(origin: string | undefined, hookId: string): string {
  return origin === undefined ? `/hook/${hookId}` : `${origin}/hook/${hookId}`;
}

/** The env a project's automations fire on, and what that machine reports about itself. */
export function useHookTarget(projectId: string | undefined, fallbackInfo?: ServerInfo): { origin: string | undefined; relayClientUrl: string | undefined } {
  const state = useEnvironments();
  const envId = (projectId === undefined ? undefined : envOfProject(projectId)) ?? state.primaryId;
  const info = (envId === undefined ? undefined : state.statuses[envId]?.info) ?? fallbackInfo;
  return { origin: envHttpOrigin(envId, state), relayClientUrl: info?.relay?.clientUrl };
}

/** The URLs that fire a webhook automation, each with a Copy button. */
export function WebhookUrls({
  hookId,
  projectId,
  fallbackInfo,
  compact = false,
}: {
  hookId: string;
  projectId: string | undefined;
  fallbackInfo?: ServerInfo | undefined;
  compact?: boolean;
}) {
  const { origin, relayClientUrl } = useHookTarget(projectId, fallbackInfo);
  const direct = directHookUrl(origin, hookId);
  const relay = relayClientUrl === undefined ? undefined : relayHookUrl(relayClientUrl, hookId);
  const rows: { label: string; url: string }[] = [
    { label: "Direct", url: direct },
    ...(relay === undefined ? [] : [{ label: "Through the relay", url: relay }]),
  ];
  return (
    <ul className={`${styles.list} ${compact ? styles.compact : ""}`} aria-label="Webhook URLs">
      {rows.map((row) => (
        <li key={row.label} className={styles.row}>
          <span className={styles.label}>{row.label}</span>
          <code className={styles.url}>POST {row.url}</code>
          <Button variant="quiet" aria-label={`Copy ${row.label.toLowerCase()} webhook URL`} onClick={() => void copyText(row.url, "webhook URL")}>
            Copy
          </Button>
        </li>
      ))}
    </ul>
  );
}
