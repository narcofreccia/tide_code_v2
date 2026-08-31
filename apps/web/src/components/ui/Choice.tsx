import styles from "./Choice.module.css";

type NativeProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "children">;

interface ChoiceProps extends NativeProps {
  /** row text; omit to render the control on its own */
  children?: React.ReactNode;
}

function Choice({ kind, children, className, ...rest }: ChoiceProps & { kind: "checkbox" | "radio" }) {
  const input = (
    <input type={kind} className={`${styles.input} ${styles[kind]}`} {...rest} />
  );
  if (children === undefined) return input;
  return (
    <label className={[styles.row, rest.disabled ? styles.disabled : "", className].filter(Boolean).join(" ")}>
      {input}
      <span className={styles.text}>{children}</span>
    </label>
  );
}

/** 14px accent-tinted checkbox with its label row. */
export function Checkbox(props: ChoiceProps) {
  return <Choice kind="checkbox" {...props} />;
}

/** 14px accent-tinted radio with its label row. */
export function Radio(props: ChoiceProps) {
  return <Choice kind="radio" {...props} />;
}
