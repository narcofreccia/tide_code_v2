import { useEnvironments } from "../../state/environments.ts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { Button } from "../ui/Button.tsx";
import { AddMachineDialog } from "../fleet/AddMachineDialog.tsx";
import { openAddMachine } from "../fleet/fleetUi.ts";
import { MachineCard } from "../fleet/MachineCard.tsx";
import { RelayPanel } from "../fleet/RelayPanel.tsx";
import { ThisMachine } from "../fleet/ThisMachine.tsx";
import fleet from "../fleet/Environments.module.css";
import section from "./Section.module.css";

/**
 * Settings › Environments: every machine running tide-server that this window drives.
 * "This machine" is the primary environment (the one whose settings this screen edits);
 * the others are listed as cards; the relay sits folded at the bottom.
 */
export function EnvironmentsSection() {
  const fetched = useServerInfo();
  const primaryId = useEnvironments((s) => s.primaryId);
  const environments = useEnvironments((s) => s.environments);
  const liveInfo = useEnvironments((s) => (s.primaryId === undefined ? undefined : s.statuses[s.primaryId]?.info));
  const info = liveInfo ?? fetched;
  const others = environments.filter((env) => env.id !== primaryId && env.id !== info?.environmentId);

  return (
    <div className={section.section}>
      <ThisMachine info={info} envId={primaryId} />

      <section className={section.section} aria-label="Other machines">
        <div className={section.head}>
          <h3 className={section.title}>Other machines</h3>
          <Button variant="primary" onClick={() => openAddMachine()}>
            Add machine
          </Button>
        </div>
        {others.length === 0 ? (
          <p className={section.note}>
            None yet. Run Tide on another computer (a desktop, a build box, a VM), pick Pair another device there, and add
            it here: its projects and threads show up in this window and keep running on that machine.
          </p>
        ) : (
          <ul className={fleet.cards}>
            {others.map((env) => (
              <MachineCard key={env.id} env={env} />
            ))}
          </ul>
        )}
      </section>

      <RelayPanel info={info} />
      <AddMachineDialog />
    </div>
  );
}
