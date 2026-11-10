import { copyWithToast } from "../../lib/clipboard.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./ProviderCard.module.css";

/**
 * One fix step for a harness: the shell command with Copy, and the docs page when there is one.
 * Copy only: the server opens terminals for a thread or a run stack, not before the first thread
 * exists, so pasting into the user's own terminal is the honest way.
 */
export function SetupStep({ name, command, url, what }: { name: string; command?: string | undefined; url?: string | undefined; what: "install" | "login" }) {
  if (command === undefined && url === undefined) return null;
  return (
    <span className={styles.setup}>
      {command === undefined ? null : (
        <>
          <code className={styles.setupCommand}>{command}</code>
          <Button variant="quiet" onClick={() => void copyWithToast(command, `Copied: ${command}`)} title={`Copy the ${what} command for ${name}`}>
            Copy
          </Button>
        </>
      )}
      {url === undefined ? null : (
        <a className={styles.docs} href={url} target="_blank" rel="noreferrer" aria-label={`${name} docs`}>
          Docs
          <Icon name="external" size={12} />
        </a>
      )}
    </span>
  );
}
