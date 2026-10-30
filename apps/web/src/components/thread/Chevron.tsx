import { Icon } from "../ui/Icon.tsx";
import styles from "./Chevron.module.css";

/** The disclosure mark of a collapsible line or card: `chevronRight`, rotated down while open. */
export function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return <Icon name="chevronRight" size={size} className={open ? `${styles.chevron} ${styles.open}` : `${styles.chevron}`} />;
}
