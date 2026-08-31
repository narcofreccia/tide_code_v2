import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExpertsSession, ProviderKind } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { PlanCard } from "../thread/PlanCard.tsx";
import markdown from "../thread/MessageItem.module.css";
import styles from "./Board.module.css";

/**
 * The lead's write-up. When it produced a plan the ordinary PlanCard renders it,
 * so "Implement in new thread" behaves exactly as it does in a thread.
 */
export function SynthesisPanel({ session, provider }: { session: ExpertsSession; provider: ProviderKind }) {
  const planId = session.synthesis?.planId;
  const plan = useModel((s) => (planId ? s.model.plans[planId] : undefined));
  if (!session.synthesis) return null;

  return (
    <section className={styles.synthesis} aria-label="Synthesis">
      <h3 className={styles.laneTitle}>Synthesis</h3>
      <div className={markdown.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{session.synthesis.markdown}</ReactMarkdown>
      </div>
      {plan ? (
        <ul className={styles.planList}>
          <PlanCard plan={plan} provider={provider} />
        </ul>
      ) : null}
    </section>
  );
}
