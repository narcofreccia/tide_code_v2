import type { ProviderKind } from "@tide/contracts";
import { PROVIDER_LABELS, PROVIDER_MONOGRAMS } from "../../../lib/vocab.ts";
import styles from "./StageList.module.css";

/**
 * One member of a composition list (expert, stage, the lead). The marker in the
 * gutter carries the order; title and subtitle are the role; `harness` sits
 * right. Reorder/remove float in on hover or keyboard focus.
 */
export function StageCard({
  marker,
  label,
  tone = "stage",
  title,
  subtitle,
  harness,
  subject,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
  onRemove,
  canRemove = true,
  children,
}: {
  /** "01", "02"… or a role glyph ("◆" for the lead) */
  marker: string;
  /** accessible name of the card ("Stage 2", "Lead") */
  label: string;
  tone?: "stage" | "lead";
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  harness?: React.ReactNode;
  /** names the card in its control labels: "Move {subject} up", "Remove {subject}" */
  subject?: string;
  onMove?: (delta: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onRemove?: () => void;
  canRemove?: boolean;
  /** detail area under the head: settings strip, persona editor */
  children?: React.ReactNode;
}) {
  const name = subject ?? label;
  const tools = onMove !== undefined || onRemove !== undefined;
  return (
    <li className={`${styles.card} ${tone === "lead" ? styles.lead : ""}`} aria-label={label}>
      <div className={styles.gutter}>
        <span className={styles.marker} aria-hidden="true">
          {marker}
        </span>
      </div>
      <div className={styles.main}>
        <div className={styles.head}>
          <div className={styles.titles}>
            {title}
            {subtitle}
          </div>
          {harness === undefined ? null : <div className={styles.harness}>{harness}</div>}
        </div>
        {children}
      </div>
      {tools ? (
        <div className={styles.tools}>
          {onMove === undefined ? null : (
            <>
              <button
                type="button"
                className={styles.tool}
                disabled={!canMoveUp}
                aria-label={`Move ${name} up`}
                title="Move up"
                onClick={() => onMove(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.tool}
                disabled={!canMoveDown}
                aria-label={`Move ${name} down`}
                title="Move down"
                onClick={() => onMove(1)}
              >
                ↓
              </button>
            </>
          )}
          {onRemove === undefined ? null : (
            <button
              type="button"
              className={`${styles.tool} ${styles.remove}`}
              disabled={!canRemove}
              aria-label={`Remove ${name}`}
              title="Remove"
              onClick={onRemove}
            >
              ×
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Two-digit, tabular: the order reads like a run sheet. */
export function stageMarker(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** The card title as an inline-editable field: text until hovered or focused. */
export function StageTitleInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  return (
    <input
      className={styles.titleInput}
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The tagline under the title, same inline treatment, quieter. */
export function StageSubtitleInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  return (
    <input
      className={styles.subtitleInput}
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Read-only title / subtitle for cards that are previews (New thread › Team). */
export function StageTitle({ children }: { children: React.ReactNode }) {
  return <span className={styles.titleText}>{children}</span>;
}
export function StageSubtitle({ children }: { children: React.ReactNode }) {
  return <span className={styles.subtitleText}>{children}</span>;
}

/** The harness monogram: one letter in a square, the full name as tooltip. */
export function HarnessMark({ provider }: { provider: ProviderKind }) {
  return (
    <span className={styles.mark} title={PROVIDER_LABELS[provider]} aria-hidden="true">
      {PROVIDER_MONOGRAMS[provider]}
    </span>
  );
}

/** Read-only "C  Claude Code · opus" for preview cards. */
export function HarnessTag({ provider, model }: { provider: ProviderKind; model?: string | undefined }) {
  return (
    <span className={styles.tag}>
      <HarnessMark provider={provider} />
      <span className={styles.tagText}>
        {PROVIDER_LABELS[provider]}
        {model === undefined || model === "" ? null : <span className={styles.tagModel}> · {model}</span>}
      </span>
    </span>
  );
}

/** A small labelled control inside a card's settings strip. */
export function StageSetting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.setting}>
      <span className={styles.settingLabel}>{label}</span>
      {children}
    </div>
  );
}

export function StageSettings({ children }: { children: React.ReactNode }) {
  return <div className={styles.settings}>{children}</div>;
}

/** A fixed value in the settings strip, where a control would otherwise go. */
export function StageSettingText({ children }: { children: React.ReactNode }) {
  return <span className={styles.settingText}>{children}</span>;
}
