import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PrComment } from "@tide/contracts";
import { relativeTime } from "../../lib/relativeTime.ts";
import { Pill, type PillTone } from "../ui/Pill.tsx";
import styles from "./PrDetail.module.css";

export interface CommentGroup {
  /** `path:line`, or undefined for the conversation */
  anchor?: string;
  comments: PrComment[];
}

/** Conversation (comments + reviews) first, then one thread per `path:line`, each oldest first. */
export function groupComments(comments: readonly PrComment[]): CommentGroup[] {
  const conversation: PrComment[] = [];
  const anchored = new Map<string, PrComment[]>();
  for (const c of [...comments].sort((a, b) => a.createdAt - b.createdAt)) {
    if (c.path === undefined) {
      conversation.push(c);
      continue;
    }
    const anchor = c.line === undefined ? c.path : `${c.path}:${c.line}`;
    anchored.set(anchor, [...(anchored.get(anchor) ?? []), c]);
  }
  const groups: CommentGroup[] = conversation.length > 0 ? [{ comments: conversation }] : [];
  for (const anchor of [...anchored.keys()].sort()) groups.push({ anchor, comments: anchored.get(anchor) ?? [] });
  return groups;
}

const REVIEW_TONE: Record<string, PillTone> = { approved: "ok", changes_requested: "needs", commented: "muted", dismissed: "idle" };

function CommentItem({ comment }: { comment: PrComment }) {
  return (
    <li className={styles.comment}>
      <div className={styles.commentHead}>
        <span className={styles.author}>@{comment.author}</span>
        {comment.kind === "review" ? (
          <Pill tone={REVIEW_TONE[comment.reviewState ?? ""] ?? "muted"}>
            review{comment.reviewState ? `: ${comment.reviewState.replaceAll("_", " ")}` : ""}
          </Pill>
        ) : null}
        <span className={styles.when}>{relativeTime(comment.createdAt)}</span>
      </div>
      {comment.body.trim() === "" ? null : (
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
        </div>
      )}
    </li>
  );
}

export function PrComments({ comments }: { comments: readonly PrComment[] }) {
  const groups = groupComments(comments);
  if (groups.length === 0) return <p className={styles.note}>No comments or reviews yet.</p>;
  return (
    <div className={styles.comments}>
      {groups.map((group) => (
        <section key={group.anchor ?? "conversation"} className={styles.group} aria-label={group.anchor ?? "Conversation"}>
          <h4 className={styles.groupHead}>{group.anchor ?? "Conversation"}</h4>
          <ul className={styles.commentList}>
            {group.comments.map((c) => (
              <CommentItem key={c.id} comment={c} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
