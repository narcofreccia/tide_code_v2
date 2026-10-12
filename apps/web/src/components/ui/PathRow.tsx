import { fileGlyph } from "../../lib/fileIcons.ts";
import styles from "./PathRow.module.css";

/** A path as `glyph name dir/` — the row content of ⌘P and the `@` mention picker. */
export function PathRow({ path }: { path: string }) {
  return (
    <>
      <span className={styles.glyph}>{fileGlyph(path)}</span>
      <span className={styles.name}>{path.slice(path.lastIndexOf("/") + 1)}</span>
      <span className={styles.dir}>{path.slice(0, path.lastIndexOf("/"))}</span>
    </>
  );
}
