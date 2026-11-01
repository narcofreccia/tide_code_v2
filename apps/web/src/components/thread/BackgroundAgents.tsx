import { memo, useState } from "react";
import { BACKGROUND_QUIET_MS, selectBackgroundAgents, type BackgroundAgent } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useBackgroundAgentCount } from "../../state/hooks.ts";
import { revealChild } from "../../state/childReveal.ts";
import { backgroundAgentsText } from "../../lib/vocab.ts";
import { plural } from "../../lib/format.ts";
import { formatElapsed, useTicker } from "../mission/useTicker.ts";
import { Chevron } from "./Chevron.tsx";
import { LiveLabel } from "./LiveLabel.tsx";
import styles from "./BackgroundAgents.module.css";

/** the shimmer cannot ellipsize (its sweep copy must match the drawn text): cap the name */
const NAME_MAX = 48;

/** More than this many agents fold into one summary line. */
export const STRIP_MAX_ROWS = 3;

/** `8s` / `12m` / `1h 5m` */
export function shortDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 === 0 ? `${hours}h` : `${hours}h ${mins % 60}m`;
}

/** What the agent did last, or how long it has been silent: "last: Read skills.py · 8s ago", "quiet for 12m". */
export function lastText(agent: BackgroundAgent): string {
  if (agent.quietMs >= BACKGROUND_QUIET_MS) return `quiet for ${shortDuration(agent.quietMs)}`;
  if (agent.last === undefined) return `started ${shortDuration(agent.quietMs)} ago`;
  const what = agent.last.target === undefined ? agent.last.toolName : `${agent.last.toolName} ${agent.last.target}`;
  return `last: ${what} · ${shortDuration(agent.quietMs)} ago`;
}

function AgentRow({ agent, now }: { agent: BackgroundAgent; now: number }) {
  const quiet = agent.quietMs >= BACKGROUND_QUIET_MS;
  const elapsed = formatElapsed(now - agent.startedAt);
  const last = lastText(agent);
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-quiet={quiet ? "" : undefined}
        title={`${agent.name}${agent.description ? ` (${agent.description})` : ""} · running ${elapsed} · ${last} — show in the transcript`}
        onClick={() => revealChild(agent.threadId, agent.childKey)}
      >
        <span className={styles.dot} aria-hidden="true" />
        <LiveLabel text={agent.name.length > NAME_MAX ? `${agent.name.slice(0, NAME_MAX - 1)}…` : agent.name} className={styles.name} />
        {agent.description ? <span className={styles.description}>{agent.description}</span> : null}
        <span className={styles.last}>{last}</span>
        <span className={styles.count}>{plural(agent.toolCalls, "tool")}</span>
        <span className={styles.elapsed} aria-label={`running for ${elapsed}`}>
          {elapsed}
        </span>
      </button>
    </li>
  );
}

/**
 * Sub-agents the harness keeps running after the turn that launched them settled, just
 * above the composer: one row each (click: show it in the transcript), folded into one
 * line past three, gone when none run. `now` overrides the 1s clock (tests).
 */
export const BackgroundAgents = memo(function BackgroundAgents({ threadId, now }: { threadId: string; now?: number }) {
  // nothing ticks while no agent runs in the background
  const count = useBackgroundAgentCount(threadId);
  return count === 0 ? null : <AgentStrip threadId={threadId} fixedNow={now} />;
});

function AgentStrip({ threadId, fixedNow }: { threadId: string; fixedNow: number | undefined }) {
  const ticked = useTicker(fixedNow === undefined ? 1000 : 0);
  const now = fixedNow ?? ticked;
  const agents = useModel((s) => selectBackgroundAgents(s.model, threadId, now));
  const [expanded, setExpanded] = useState(false);
  if (agents.length === 0) return null;
  const folded = agents.length > STRIP_MAX_ROWS && !expanded;
  const newest = agents.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
  return (
    <section className={styles.strip} aria-label="Background agents">
      {agents.length > STRIP_MAX_ROWS ? (
        <button type="button" className={styles.summary} aria-expanded={!folded} onClick={() => setExpanded((v) => !v)}>
          <Chevron open={!folded} />
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.summaryText}>{backgroundAgentsText(agents.length)}</span>
          <span className={styles.last}>{lastText(newest)}</span>
        </button>
      ) : null}
      {folded ? null : (
        <ul className={styles.list}>
          {agents.map((agent) => (
            <AgentRow key={agent.activityId} agent={agent} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
