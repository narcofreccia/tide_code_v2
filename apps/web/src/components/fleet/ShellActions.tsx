import { currentTheme, isRemoteLaunch, openSplash, splashUrlFor, type SplashAction } from "../../lib/bootstrap.ts";
import { Button } from "../ui/Button.tsx";
import { SettingRow } from "../settings/ui/SettingRow.tsx";

type PageLocation = { protocol: string; href: string };

/**
 * The desktop shell's own actions, which used to live only in its app menu: pair with
 * another machine, or go back to the local server. Each one hands off to the shell's
 * splash page; outside the shell (no splash) nothing renders.
 */
export function ShellActions({
  location = window.location,
  navigate = openSplash,
}: {
  location?: PageLocation;
  navigate?: (url: string) => void;
}) {
  const go = (action: SplashAction): void => {
    const url = splashUrlFor(action, location, currentTheme());
    if (url !== null) navigate(url);
  };
  if (splashUrlFor("connect", location, "system") === null) return null;
  return (
    <>
      <SettingRow
        label="Connect to another machine"
        help="Leaves this view to pair with another machine using its pairing code"
        control={<Button onClick={() => go("connect")}>Connect…</Button>}
      />
      {isRemoteLaunch(location) ? (
        <SettingRow
          label="Run the local server"
          help="Leaves this machine and switches the window back to the server on this computer"
          control={<Button onClick={() => go("local")}>Run locally</Button>}
        />
      ) : null}
    </>
  );
}
