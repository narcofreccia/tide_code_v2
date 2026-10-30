import { useEnvironments } from "../../state/environments.ts";
import { useServerInfo } from "../../lib/useServerInfo.ts";
import { Button } from "../ui/Button.tsx";
import { AddMachineDialog } from "../fleet/AddMachineDialog.tsx";
import { openAddMachine } from "../fleet/fleetUi.ts";
import { MachineCard } from "../fleet/MachineCard.tsx";
import { RelayPanel } from "../fleet/RelayPanel.tsx";
import { ThisMachine } from "../fleet/ThisMachine.tsx";
import fleet from "../fleet/Environments.module.css";
import type { SectionMeta } from "./search.ts";
import { SettingBlock, SettingNote, SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";

export const META: SectionMeta = {
  title: "Environments",
  blurb:
    "Every machine running tide-server that this window drives. This machine is the primary: its settings are the ones these pages edit.",
  keywords: ["This machine", "Machine name", "SSH host", "Other machines", "Add machine", "Pair another device", "Relay", "remote"],
};

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
    <SettingsPage title={META.title} blurb={META.blurb}>
      <ThisMachine info={info} envId={primaryId} />

      <SettingsGroup
        title="Other machines"
        actions={
          <Button variant="primary" onClick={() => openAddMachine()}>
            Add machine
          </Button>
        }
      >
        {others.length === 0 ? (
          <SettingNote>
            None yet. Run Tide on another computer (a desktop, a build box, a VM), pick Pair another device there, and add
            it here: its projects and threads show up in this window and keep running on that machine.
          </SettingNote>
        ) : (
          <SettingBlock>
            <ul className={fleet.cards}>
              {others.map((env) => (
                <MachineCard key={env.id} env={env} />
              ))}
            </ul>
          </SettingBlock>
        )}
      </SettingsGroup>

      <RelayPanel info={info} />
      <AddMachineDialog />
    </SettingsPage>
  );
}
