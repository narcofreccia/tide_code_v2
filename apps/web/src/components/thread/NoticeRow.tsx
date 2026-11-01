import { memo } from "react";
import type { Message, ProviderKind, ReadModel } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { revealChild } from "../../state/childReveal.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconName } from "../ui/Icon.tsx";
import styles from "./NoticeRow.module.css";

type Source = NonNullable<Message["notification"]>["source"];

const ICON: Record<Source, IconName> = {
  delegate: "external",
  "child-question": "inbox",
  pr: "pullRequest",
  restart: "refresh",
  system: "bell",
  schedule: "snooze",
  webhook: "bell",
  harness: "play",
};

const ACTOR: Partial<Record<ProviderKind, string>> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi" };

/** `sub-agent "Audit feature gaps" reported` → `Audit feature gaps` (the driver's reportedReason); else undefined. */
export function reportedAgentName(summary: string): string | undefined {
  const match = /^sub-agent (["'])(.+)\1 reported$/.exec(summary.trim());
  return match?.[2];
}

/**
 * The sub-agent a "<name> reported" wake-up is about: the newest child of that name
 * created before the notice (its report lives on that row). A childKey string, so it
 * can be selected from the store.
 */
export function reportedChildKey(model: ReadModel, message: Message, name: string): string | undefined {
  const entries = model.threadTimeline[message.threadId] ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== "activity") continue;
    const activity = model.activities[entry.id];
    if (activity?.kind === "child" && activity.name === name && activity.createdAt <= message.createdAt) return activity.childKey;
  }
  return undefined;
}

/** A harness-initiated turn: the continuation of background work, linked to the sub-agent that reported. */
function HarnessNotice({ message, provider, summary }: { message: Message; provider: ProviderKind | undefined; summary: string }) {
  const actor = (provider !== undefined ? ACTOR[provider] : undefined) ?? "The harness";
  const name = reportedAgentName(summary);
  const childKey = useModel((s) => (name === undefined ? undefined : reportedChildKey(s.model, message, name)));
  if (name === undefined) {
    // pass-through: whatever the driver said, after who continued
    return (
      <>
        <span className={styles.lead}>{`${actor} continued`}</span>
        <span className={styles.summary}>{summary}</span>
      </>
    );
  }
  return (
    <>
      <span className={styles.reported}>
        {childKey === undefined ? (
          <span className={styles.agent}>{name}</span>
        ) : (
          <Button variant="link" className={styles.agentLink} title="Show this sub-agent and its report" onClick={() => revealChild(message.threadId, childKey)}>
            {name}
          </Button>
        )}{" "}
        reported
      </span>
      <span className={styles.summary}>{`${actor} continued`}</span>
    </>
  );
}

/** A server-authored wake-up (delegate done, child asked, PR changed, restart) — not something the user typed. */
export const NoticeRow = memo(function NoticeRow({ message, provider }: { message: Message; provider?: ProviderKind }) {
  const notification = message.notification;
  if (!notification) return null;
  return (
    <li className={styles.notice} data-source={notification.source}>
      <Icon name={ICON[notification.source] ?? ICON.system} size={12} className={`${styles.icon}`} />
      {notification.source === "harness" ? (
        <HarnessNotice message={message} provider={provider} summary={notification.summary} />
      ) : (
        <span className={styles.summary}>{notification.summary}</span>
      )}
    </li>
  );
});
