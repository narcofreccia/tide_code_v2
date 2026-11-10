import { NOT_ENCRYPTED_LABEL, NOT_ENCRYPTED_TIP, routeSecurity } from "../../lib/routeSecurity.ts";
import { Pill } from "../ui/Pill.tsx";

/** R19: a small "Not encrypted" label for a plain-HTTP route to another machine; nothing otherwise. */
export function NotEncrypted({ url }: { url: string | undefined }) {
  if (url === undefined || routeSecurity(url) !== "plain") return null;
  return (
    <Pill size="sm" tone="needs" title={NOT_ENCRYPTED_TIP}>
      {NOT_ENCRYPTED_LABEL}
    </Pill>
  );
}
