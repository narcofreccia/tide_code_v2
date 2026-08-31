import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExpertsFinding, ExpertsMessage, ExpertsSession } from "@tide/contracts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { authorLabel } from "./labels.ts";
import markdown from "../thread/MessageItem.module.css";
import styles from "./Board.module.css";

/** What the panel agreed is worth keeping: one card per shared finding. */
export function FindingsFeed({
  session,
  findings,
}: {
  session: ExpertsSession;
  findings: ExpertsFinding[];
}) {
  return (
    <section className={styles.lane} aria-label="Findings">
      <h3 className={styles.laneTitle}>Findings</h3>
      {findings.length === 0 ? (
        <p className={styles.empty}>No findings yet.</p>
      ) : (
        <ul className={styles.cards}>
          {findings.map((finding) => (
            <li key={finding.id} className={styles.finding}>
              <div className={styles.cardHead}>
                <span className={styles.author}>{authorLabel(session, finding.author)}</span>
                <span className={styles.time}>{relativeTime(finding.createdAt)}</span>
              </div>
              <div className={markdown.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{finding.text}</ReactMarkdown>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who said what to whom; the user's own posts are highlighted. */
export function DiscussionLane({
  session,
  messages,
}: {
  session: ExpertsSession;
  messages: ExpertsMessage[];
}) {
  return (
    <section className={styles.lane} aria-label="Discussion">
      <h3 className={styles.laneTitle}>Discussion</h3>
      {messages.length === 0 ? (
        <p className={styles.empty}>Nothing said yet.</p>
      ) : (
        <ul className={styles.cards}>
          {messages.map((message) => (
            <li
              key={message.id}
              className={`${styles.message} ${message.from === "user" ? styles.mine : ""}`}
            >
              <div className={styles.cardHead}>
                <span className={styles.author}>{authorLabel(session, message.from)}</span>
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
                <span className={styles.recipient}>{authorLabel(session, message.to)}</span>
                <span className={styles.time}>{relativeTime(message.createdAt)}</span>
              </div>
              <p className={styles.messageText}>{message.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
