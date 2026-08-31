import { useState } from "react";
import type { ProviderKind } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import styles from "./CreateExpertsDialog.module.css";

/** One editable seat before the session exists. `key` is stable per row. */
export interface ExpertDraft {
  key: string;
  name: string;
  role: string;
  provider: ProviderKind;
  /** empty means "let the harness choose" */
  model: string;
  persona: string;
}

export function ExpertRowEditor({
  expert,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  expert: ExpertDraft;
  index: number;
  count: number;
  onChange: (patch: Partial<ExpertDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <input
          className={styles.input}
          aria-label={`Expert ${index + 1} name`}
          value={expert.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <input
          className={styles.input}
          aria-label={`Expert ${index + 1} role`}
          value={expert.role}
          onChange={(e) => onChange({ role: e.target.value })}
        />
        <HarnessFields
          name={`Expert ${index + 1}`}
          provider={expert.provider}
          model={expert.model}
          onChange={(patch) =>
            onChange({
              ...(patch.provider === undefined ? {} : { provider: patch.provider }),
              ...(patch.model === undefined ? {} : { model: patch.model }),
            })
          }
        />
        <div className={styles.rowActions}>
          <Button
            variant="quiet"
            disabled={index === 0}
            aria-label={`Move ${expert.name} up`}
            title="Move up"
            onClick={() => onMove(index - 1)}
          >
            ↑
          </Button>
          <Button
            variant="quiet"
            disabled={index === count - 1}
            aria-label={`Move ${expert.name} down`}
            title="Move down"
            onClick={() => onMove(index + 1)}
          >
            ↓
          </Button>
          <Button variant="quiet" aria-label={`Remove ${expert.name}`} title="Remove" onClick={onRemove}>
            ×
          </Button>
        </div>
      </div>
      <button type="button" className={styles.disclosure} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} persona
      </button>
      {open ? (
        <textarea
          className={styles.persona}
          aria-label={`Expert ${index + 1} persona`}
          value={expert.persona}
          onChange={(e) => onChange({ persona: e.target.value })}
        />
      ) : null}
    </li>
  );
}
