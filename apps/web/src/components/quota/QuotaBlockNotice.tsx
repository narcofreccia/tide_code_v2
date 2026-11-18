import type { QuotaView } from "@tide/client";
import { liftQuota, quotaBlockText, quotaTitle } from "../../lib/quota.ts";
import { useProjectDeviceLimit, useThreadDeviceLimit } from "../../state/deviceAccess.ts";
import { Button } from "../ui/Button.tsx";
import { openQuotaEditor } from "./QuotaDialog.tsx";
import styles from "./Quota.module.css";

/**
 * Above the composer while a quota holds the thread's new turns: what was reached and when it
 * resets, with Lift until reset (`quota.lift`) and Edit quota. Open in terminal stays in the header.
 */
export function QuotaBlockNotice({ view }: { view: QuotaView }) {
  // R19: lifting and editing need full access on the machine that owns the scope
  const threadLimit = useThreadDeviceLimit(view.scope === "thread" ? view.id : undefined);
  const projectLimit = useProjectDeviceLimit(view.scope === "project" ? view.id : undefined);
  const limit = view.scope === "thread" ? threadLimit : projectLimit;
  return (
    <div className={styles.block} role="status" aria-label="Quota reached">
      <span className={styles.blockText} title={quotaTitle(view)}>{quotaBlockText(view)}</span>
      <span className={styles.blockActions}>
        <Button variant="quiet" disabled={limit !== undefined} title={limit} onClick={() => liftQuota(view.scope, view.id)}>
          Lift until reset
        </Button>
        <Button variant="quiet" disabled={limit !== undefined} title={limit} onClick={() => openQuotaEditor(view.scope, view.id)}>
          Edit quota
        </Button>
      </span>
    </div>
  );
}
