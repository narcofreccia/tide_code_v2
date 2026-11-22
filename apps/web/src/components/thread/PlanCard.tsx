import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { threadSendBlock } from "@tide/client";
import type { ProposedPlan, ProviderKind } from "@tide/contracts";
import { dismissPlan, implementPlanHere, implementPlanInNewThread } from "../../lib/threadActions.ts";
import { runOrToast } from "../../lib/dispatchOrToast.ts";
import { focusComposer } from "../../lib/composerFocus.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { modeBlocked, useThreadDeviceLimit } from "../../state/deviceAccess.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Popover } from "../ui/Popover.tsx";
import { ProviderPicker, useThreadDraft } from "./ProviderPicker.tsx";
import { MarkdownLink, markdownUrlTransform } from "./MarkdownLink.tsx";
import markdown from "./MessageItem.module.css";
import styles from "./Card.module.css";
import own from "./PlanCard.module.css";

const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

/**
 * A plan-mode result. "Implement" runs it in this thread (same worktree, planning
 * context kept); the chevron seeds a new thread instead. Never runs on its own.
 */
export const PlanCard = memo(function PlanCard({ plan, provider }: { plan: ProposedPlan; provider: ProviderKind }) {
  const [draft, patch] = useThreadDraft(provider);
  const [choosing, setChoosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const selectThread = useUi((s) => s.selectThread);
  const implementedHere = plan.implementationThreadId === plan.threadId;
  const superseded = plan.status === "superseded";
  const showBody = !superseded || expanded;
  // R19: a Full access default mode is refused for a device with limited access on that machine
  const modeLimit = modeBlocked(draft.mode, useThreadDeviceLimit(plan.threadId));
  // in place it is a turn on this thread: the same refusal as the composer's (a new thread still works)
  const blocked = useModel((s) => {
    const thread = s.model.threads[plan.threadId];
    return thread === undefined ? undefined : threadSendBlock(thread)?.reason;
  });

  return (
    <li>
      <section
        className={`${styles.card} ${plan.status === "proposed" ? styles.attention : ""}`}
        aria-label="Proposed plan"
      >
        <div className={styles.head}>
          <span className={styles.title}>Proposed plan</span>
          {plan.status === "proposed" ? null : (
            <span className={styles.target}>
              {plan.status === "implemented" && implementedHere ? "implemented here" : plan.status}
            </span>
          )}
          {superseded ? (
            <Button variant="quiet" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide" : "Show"}
            </Button>
          ) : null}
        </div>
        {showBody ? (
          <div className={markdown.markdown}>
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={markdownUrlTransform}>
              {plan.markdown}
            </ReactMarkdown>
          </div>
        ) : null}
        {plan.status === "proposed" ? (
          <>
            <div className={styles.actions}>
              <div className={own.split}>
                <Button
                  variant="primary"
                  className={own.main}
                  disabled={blocked !== undefined}
                  title={blocked ?? "Run the plan in this thread"}
                  onClick={() => {
                    runOrToast("Implementing the plan", () => implementPlanHere(plan.id));
                    focusComposer();
                  }}
                >
                  Implement
                </Button>
                <Popover
                  variant="primary"
                  triggerClassName={own.chevron}
                  ariaLabel="Implement in a new thread"
                  title="Implement in a new thread"
                  onOpenChange={setChoosing}
                  label={<Icon name="chevronDown" size={12} />}
                >
                  {(close) => (
                    <>
                      <span className={own.heading}>In a new thread</span>
                      <ProviderPicker draft={draft} onChange={patch} />
                      {modeLimit === undefined ? null : <p className={own.why}>{modeLimit}</p>}
                      <Button
                        variant="primary"
                        disabled={modeLimit !== undefined}
                        title={modeLimit}
                        onClick={() => {
                          close();
                          runOrToast("Implementing the plan", () =>
                            implementPlanInNewThread(plan.id, {
                              provider: draft.provider,
                              ...(draft.model === "" ? {} : { model: draft.model }),
                              ...(draft.mode === undefined ? {} : { mode: draft.mode }),
                              useWorktree: draft.useWorktree,
                            }),
                          );
                        }}
                      >
                        Go
                      </Button>
                    </>
                  )}
                </Popover>
              </div>
              <Button onClick={() => focusComposer()}>Keep planning</Button>
              <Button onClick={() => dismissPlan(plan.id)}>Dismiss</Button>
            </div>
            {choosing ? (
              <p className={own.why}>
                Same thread keeps the planning context and worktree. A new thread starts clean, optionally on
                another harness.
              </p>
            ) : null}
          </>
        ) : plan.implementationThreadId && !implementedHere ? (
          <Button variant="link" onClick={() => selectThread(plan.implementationThreadId ?? null)}>
            open implementation thread
          </Button>
        ) : null}
      </section>
    </li>
  );
});
