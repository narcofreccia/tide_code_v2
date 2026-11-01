import { memo, useMemo } from "react";
import { selectThreadLinks } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import styles from "./ThreadLinkChips.module.css";

/**
 * The linked repositories this thread can reach, read-only: a live thread's set
 * is fixed at creation, so there is nothing to edit here. Subscribes to the thread
 * and its project only (the links' sole inputs), not to the whole model.
 */
export const ThreadLinkChips = memo(function ThreadLinkChips({ threadId }: { threadId: string }) {
  const thread = useModel((s) => s.model.threads[threadId]);
  const project = useModel((s) => (thread ? s.model.projects[thread.projectId] : undefined));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- thread and project are what selectThreadLinks reads
  const links = useMemo(() => selectThreadLinks(useModel.getState().model, threadId), [threadId, thread, project]);
  if (links.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label="Linked repositories">
      {links.map(({ link, access }) => (
        <li
          key={link.id}
          className={styles.chip}
          title={link.note ? `${link.path} — ${link.note}` : link.path}
        >
          <Icon name="folder" size={12} />
          <span className={styles.label}>{link.label}</span>
          <span className={styles.access}>{access === "write" ? "rw" : "ro"}</span>
        </li>
      ))}
    </ul>
  );
});
