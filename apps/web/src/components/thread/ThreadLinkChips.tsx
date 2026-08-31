import { selectThreadLinks } from "@tide/client";
import { useModel } from "../../state/model.ts";
import styles from "./ThreadLinkChips.module.css";

/** Linked repos are secondary roots, so they carry the same glyph everywhere. */
export const LINK_GLYPH = "⧉";

/**
 * The linked repositories this thread can reach, read-only: a live thread's set
 * is fixed at creation, so there is nothing to edit here.
 */
export function ThreadLinkChips({ threadId }: { threadId: string }) {
  const links = selectThreadLinks(useModel((s) => s.model), threadId);
  if (links.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label="Linked repositories">
      {links.map(({ link, access }) => (
        <li
          key={link.id}
          className={styles.chip}
          title={link.note ? `${link.path} — ${link.note}` : link.path}
        >
          <span aria-hidden="true">{LINK_GLYPH}</span>
          <span className={styles.label}>{link.label}</span>
          <span className={styles.access}>{access === "write" ? "rw" : "ro"}</span>
        </li>
      ))}
    </ul>
  );
}
