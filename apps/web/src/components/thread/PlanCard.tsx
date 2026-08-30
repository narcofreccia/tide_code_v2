import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ProposedPlan, ProviderKind } from "@tide/contracts";
import { dismissPlan, implementPlan } from "../../lib/threadActions.ts";
import { focusComposer } from "../../lib/composerFocus.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { ProviderPicker, useThreadDraft } from "./ProviderPicker.tsx";
import markdown from "./MessageItem.module.css";
import styles from "./Card.module.css";

/** A plan-mode result. Implementing it always creates a new thread, never runs here. */
export function PlanCard({ plan, provider }: { plan: ProposedPlan; provider: ProviderKind }) {
  const [draft, patch] = useThreadDraft(provider);
  const selectThread = useUi((s) => s.selectThread);

  return (
    <li>
      <section
        className={`${styles.card} ${plan.status === "proposed" ? styles.attention : ""}`}
        aria-label="Proposed plan"
      >
        <div className={styles.head}>
          <span className={styles.title}>Proposed plan</span>
          {plan.status === "proposed" ? null : <span className={styles.target}>{plan.status}</span>}
        </div>
        <div className={markdown.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.markdown}</ReactMarkdown>
        </div>
        {plan.status === "proposed" ? (
          <div className={styles.actions}>
            <Popover variant="primary" label="Implement in new thread ▾">
              {(close) => (
                <>
                  <ProviderPicker draft={draft} onChange={patch} />
                  <Button
                    variant="primary"
                    onClick={() => {
                      close();
                      void implementPlan(plan.id, {
                        provider: draft.provider,
                        ...(draft.model === "" ? {} : { model: draft.model }),
                        ...(draft.mode === undefined ? {} : { mode: draft.mode }),
                        useWorktree: draft.useWorktree,
                      }).catch(() => undefined);
                    }}
                  >
                    Go
                  </Button>
                </>
              )}
            </Popover>
            <Button onClick={() => focusComposer()}>Keep planning</Button>
            <Button onClick={() => dismissPlan(plan.id)}>Dismiss</Button>
          </div>
        ) : plan.implementationThreadId ? (
          <button
            type="button"
            className={styles.link}
            onClick={() => selectThread(plan.implementationThreadId ?? null)}
          >
            open implementation thread
          </button>
        ) : null}
      </section>
    </li>
  );
}
