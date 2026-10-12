import styles from "./Button.module.css";

/** `link` is the inline accent text action ("all threads →", "open as thread", tab ×). */
export type ButtonVariant = "primary" | "ghost" | "quiet" | "link";

export function Button({
  variant = "ghost",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
    />
  );
}
