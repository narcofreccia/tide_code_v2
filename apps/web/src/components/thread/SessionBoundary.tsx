import { memo } from "react";
import { useModel } from "../../state/model.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { threadHarnessLabel } from "../../lib/vocab.ts";
import styles from "./SessionBoundary.module.css";

/** R17: a new native session began with this turn; earlier messages are not in the harness's context. */
export const SessionBoundary = memo(function SessionBoundary({ turnId }: { turnId: string }) {
  const turn = useModel((s) => s.model.turns[turnId]);
  const thread = useModel((s) => (turn ? s.model.threads[turn.threadId] : undefined));
  const providers = useProvidersSnapshot();
  const source = turn?.provider !== undefined ? { provider: turn.provider, ...(turn.providerId === undefined ? {} : { providerId: turn.providerId }) } : thread;
  const label = source === undefined ? undefined : threadHarnessLabel(providers, source);
  return (
    <li className={styles.notice} data-session-boundary="">
      <span className={styles.rule} aria-hidden="true" />
      <span className={styles.text}>{label === undefined ? "New session" : `New session · ${label}`}</span>
      <span className={styles.rule} aria-hidden="true" />
    </li>
  );
});
