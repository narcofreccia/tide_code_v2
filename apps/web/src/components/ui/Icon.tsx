import { ICONS, type IconName } from "./icons.ts";
import styles from "./Icon.module.css";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** px; icons are drawn for 16 */
  size?: number;
  /** when set, the icon is meaningful on its own: `role="img"` + `aria-label` */
  label?: string;
  className?: string | undefined;
}

/** Inline SVG icon in the stroke style of the set: currentColor, 1.75, round caps. */
export function Icon({ name, size = 16, label, className }: IconProps) {
  const a11y = label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  return (
    <svg
      className={className === undefined ? styles.icon : `${styles.icon} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
