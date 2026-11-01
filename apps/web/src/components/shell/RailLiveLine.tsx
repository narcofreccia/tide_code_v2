import type { LiveLabelInfo } from "../../lib/liveLabel.ts";
import type { ThreadStateKey } from "../../lib/vocab.ts";
import { LiveLabel } from "../thread/LiveLabel.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./RailThreadRow.module.css";

/**
 * A row recedes (regular weight, secondary text) when its thread asks nothing of
 * the user: running (in the foreground or the background), idle or snoozed, not unread, not selected, not waiting on them.
 */
export function recedes(opts: { state: ThreadStateKey; unread: boolean; active: boolean; picked: boolean; live?: LiveLabelInfo | undefined }): boolean {
  if (opts.unread || opts.active || opts.picked) return false;
  if (opts.live?.kind === "approval") return false;
  return opts.state === "running" || opts.state === "background" || opts.state === "idle" || opts.state === "merged" || opts.state === "snoozed";
}

const RAIL_LABEL_MAX = 44;

/** The row's second line while something is happening: what the agent is doing, or what it waits on. */
export function RailLiveLine({ live, title }: { live: LiveLabelInfo; title?: string | undefined }) {
  const kind = live.kind ?? "writing";
  let body: React.ReactNode;
  if (kind === "approval") {
    body = (
      <>
        <Icon name="bell" size={12} />
        <span className={styles.liveText}>{live.text}</span>
      </>
    );
  } else if (kind === "tool" || kind === "thinking" || kind === "writing" || kind === "background") {
    // the shimmer cannot ellipsize (its sweep copy must match the drawn text): cap it for the narrow rail
    body = <LiveLabel text={live.text.length > RAIL_LABEL_MAX ? `${live.text.slice(0, RAIL_LABEL_MAX - 1)}…` : live.text} className={styles.liveText} />;
  } else {
    body = <span className={styles.liveText}>{live.text}</span>;
  }
  return (
    <span className={styles.live} data-live-kind={kind} title={title ?? live.text}>
      {body}
    </span>
  );
}
