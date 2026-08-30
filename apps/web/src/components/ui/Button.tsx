import styles from "./Button.module.css";

type Variant = "primary" | "ghost" | "quiet";

export function Button({
  variant = "ghost",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
    />
  );
}
