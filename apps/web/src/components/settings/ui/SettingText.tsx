import { useEffect, useState } from "react";
import { useTrackSave, type ChangeResult } from "./saved.ts";
import styles from "./settings.module.css";

/**
 * A text field that commits on blur or Enter. `normalize` rewrites what was typed (and the field
 * shows the result); `validate` returns an error message that blocks the commit.
 */
export function SettingText({
  id,
  value,
  onCommit,
  label,
  suffix,
  validate,
  normalize,
  placeholder,
  size = "wide",
  mono = false,
  type = "text",
  inputMode,
  min,
  step,
  multiline = false,
  maxLength,
}: {
  id?: string;
  value: string;
  onCommit: (value: string) => ChangeResult;
  label?: string;
  suffix?: React.ReactNode;
  validate?: (value: string) => string | undefined;
  normalize?: (value: string) => string;
  placeholder?: string;
  size?: "short" | "wide";
  mono?: boolean;
  type?: "text" | "number";
  inputMode?: "numeric" | "text";
  min?: number;
  step?: number;
  /** a textarea: Enter adds a line, ⌘/Ctrl+Enter or blur commits */
  multiline?: boolean;
  maxLength?: number;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | undefined>(undefined);
  const track = useTrackSave();
  useEffect(() => setText(value), [value]);

  const commit = (): void => {
    const next = normalize ? normalize(text) : text;
    setText(next);
    const problem = validate?.(next);
    setError(problem);
    if (problem !== undefined || next === value) return;
    track(() => onCommit(next));
  };

  if (multiline) {
    return (
      <span className={styles.field}>
        <textarea
          id={id}
          className={[styles.input, styles.multiline, mono ? styles.mono : ""].filter(Boolean).join(" ")}
          rows={3}
          maxLength={maxLength}
          aria-label={label}
          aria-invalid={error !== undefined}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        {error === undefined ? null : (
          <span className={styles.fieldError} role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className={styles.field}>
      <input
        id={id}
        className={[styles.input, styles[size], mono ? styles.mono : ""].filter(Boolean).join(" ")}
        type={type}
        inputMode={inputMode}
        min={min}
        step={step}
        aria-label={label}
        aria-invalid={error !== undefined}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {suffix === undefined ? null : <span className={styles.suffix}>{suffix}</span>}
      {error === undefined ? null : (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
