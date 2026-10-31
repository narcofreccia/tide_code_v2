import { Icon } from "../../ui/Icon.tsx";
import { revealInTree } from "../tree/revealInTree.ts";
import styles from "./FileTab.module.css";

/** The file's path as crumbs: each folder opens the tree on it, the file name is plain text. */
export function Breadcrumbs({ threadId, path }: { threadId: string; path: string }) {
  const parts = path.split("/").filter(Boolean);
  const last = parts.length - 1;
  return (
    <nav className={styles.crumbs} aria-label="File path" title={path}>
      {parts.map((part, index) => {
        const dir = parts.slice(0, index + 1).join("/");
        return (
          <span key={dir} className={styles.crumb}>
            {index === 0 ? null : <Icon name="chevronRight" size={10} className={styles.crumbSep ?? ""} />}
            {index === last ? (
              <span className={styles.crumbFile} aria-current="page">
                {part}
              </span>
            ) : (
              <button type="button" className={styles.crumbButton} title={`Show ${dir} in the file tree`} onClick={() => revealInTree(threadId, dir)}>
                {part}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
