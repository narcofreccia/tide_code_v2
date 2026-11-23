import { useMemo } from "react";
import type { ProviderKind } from "@tide/contracts";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { DELEGATE_PREFIX } from "../../lib/mentions.ts";
import { providerIdOf } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useProviders } from "../../state/providers.ts";
import { Icon } from "../ui/Icon.tsx";
import { ListPickerList } from "../ui/ListPicker.tsx";
import styles from "./MentionPicker.module.css";

const DELEGATE_LIMIT = 6;

export interface DelegateMatch {
  providerId: string;
  /** the harness kind (`kind` is taken by the picker item's discriminant) */
  harness: ProviderKind;
  label: string;
  model?: string;
}

/**
 * Harness instances `tide_delegate` can reach (installed and signed in, not this thread's own).
 * `codex/glm` fuzzy-matches the instance's models on the part after `/`; `@delegate:` lists them all.
 */
export function useDelegateMatches(threadId: string, query: string | undefined): DelegateMatch[] {
  const providers = useProviders();
  const thread = useModel((s) => s.model.threads[threadId]);
  const own = thread === undefined ? undefined : providerIdOf(thread);
  return useMemo(() => {
    if (query === undefined) return [];
    const q = query.startsWith(DELEGATE_PREFIX) ? query.slice(DELEGATE_PREFIX.length) : query;
    const slash = q.indexOf("/");
    const head = slash < 0 ? q : q.slice(0, slash);
    const modelQuery = slash < 0 ? undefined : q.slice(slash + 1);
    // Include this thread's own harness when explicitly targeting a model (`@codex/…`, `@delegate:claude/haiku`).
    const live = providers.filter((p) => p.installed && p.loggedIn && (modelQuery !== undefined || p.id !== own));
    const ranked = head === "" ? live : fuzzyRank(head, live, (p) => `${p.id} ${p.label}`, DELEGATE_LIMIT).map((r) => r.item);
    const out: DelegateMatch[] = [];
    for (const p of ranked) {
      const base = { providerId: p.id, harness: p.kind, label: p.label };
      if (modelQuery === undefined) {
        const model = p.models.find((m) => m.default)?.id;
        out.push(model === undefined ? base : { ...base, model });
      } else if (modelQuery === "") {
        out.push(...p.models.slice(0, 3).map((m) => ({ ...base, model: m.id })));
      } else {
        out.push(...fuzzyRank(modelQuery, p.models, (m) => `${m.id} ${m.label}`, 3).map((r) => ({ ...base, model: r.item.id })));
      }
    }
    return out.slice(0, DELEGATE_LIMIT);
  }, [providers, own, query]);
}

/** The "Delegate to" rows of the `@` picker; `offset` is how many rows precede them. */
export function DelegateSection({ matches, offset, cursor, onPick }: {
  matches: DelegateMatch[];
  offset: number;
  cursor: number;
  onPick: (match: DelegateMatch) => void;
}) {
  if (matches.length === 0) return null;
  return (
    <>
      <p className={styles.section}>Delegate to</p>
      <ListPickerList
        items={matches}
        itemKey={(m) => `${m.providerId}/${m.model ?? ""}`}
        renderItem={(m) => (
          <span className={styles.thread}>
            <Icon name="inbox" size={12} />
            {m.label}
            {m.model === undefined ? "" : ` · ${m.model}`}
          </span>
        )}
        active={cursor - offset}
        onPick={onPick}
        label="Delegate to a harness"
        pickOn="mousedown"
        dense
      />
    </>
  );
}
