import { selectHeldProjects, type HeldProject } from "@tide/client";
import { plural } from "../../lib/format.ts";
import { liftQuota, quotaResetText, quotaTitle } from "../../lib/quota.ts";
import { useModel } from "../../state/model.ts";
import { useProjectDeviceLimit } from "../../state/deviceAccess.ts";
import { openQuotaEditor } from "../quota/QuotaDialog.tsx";
import { QuotaMeter } from "../quota/QuotaMeter.tsx";
import { Button } from "../ui/Button.tsx";
import { useTicker } from "./useTicker.ts";
import mc from "./MissionControl.module.css";
import styles from "../quota/Quota.module.css";

function HeldRow({ held }: { held: HeldProject }) {
  const { view, threads } = held;
  // R19: lifting and editing a quota need full access on the project's machine
  const limit = useProjectDeviceLimit(view.id);
  const reset = quotaResetText(view);
  return (
    <li className={styles.heldRow} aria-label={`Held project ${view.title}`}>
      <span className={styles.heldTitle} title={quotaTitle(view)}>
        {view.title}
      </span>
      <span className={styles.heldMeta}>
        Held by quota · {plural(threads.length, "thread")}
        {reset === undefined ? "" : ` · ${reset}`}
      </span>
      <QuotaMeter view={view} />
      <Button variant="quiet" disabled={limit !== undefined} title={limit} onClick={() => liftQuota("project", view.id)}>
        Lift until reset
      </Button>
      <Button variant="quiet" disabled={limit !== undefined} title={limit} onClick={() => openQuotaEditor("project", view.id)}>
        Edit quota
      </Button>
    </li>
  );
}

/** One row per project whose quota holds new turns right now. Absent when none does. */
export function QuotaHeldSection({ projectId }: { projectId?: string }) {
  const model = useModel((s) => s.model);
  const capped = Object.values(model.projects).some((p) => p.quota !== undefined);
  // a window ending frees the hold without an event
  useTicker(capped ? 60_000 : 0);
  const held = selectHeldProjects(model, projectId === undefined ? undefined : [projectId], Date.now());
  if (held.length === 0) return null;
  return (
    <section className={mc.section} aria-label="Held by quota">
      <h2 className={mc.label}>Held by quota · {held.length}</h2>
      <ul className={mc.list}>
        {held.map((h) => (
          <HeldRow key={h.view.id} held={h} />
        ))}
      </ul>
    </section>
  );
}
