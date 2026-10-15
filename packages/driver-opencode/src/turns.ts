import type { OpencodeApi } from "./types.ts";
import type { WireMessage } from "./wire.ts";

/**
 * Where each turn of an OpenCode 2 session starts, for `rollback(n)`.
 *
 * One Tide `send()` is one prompt, which runs one execution; the execution ends by appending an
 * `idle` message (core 2.0.27 message-updater, `session.execution.{succeeded,failed,interrupted}`).
 * A steer is promoted inside the running execution, before its `idle`. So the user message that
 * started a turn is the first `user` message after an `idle` (or the session's first one), and
 * a steered turn still counts once. This reads the session itself, so it also works for history
 * this process never saw (a resumed or forked session, whose copied messages get new ids).
 */

const PAGE = 200; // the route's maximum (`SessionMessagesQuery.limit` ≤ 200)

/** Turn-start user message ids, newest first, reading pages until `wanted` are known. */
export async function turnStartsNewestFirst(api: OpencodeApi, sessionId: string, wanted: number): Promise<string[]> {
  const starts: string[] = [];
  /** the oldest user message seen since the last (newer) `idle` */
  let candidate: string | undefined;
  let cursor: string | undefined;
  for (;;) {
    const page = await api.messages({ sessionId, limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) });
    for (const message of page.data) {
      candidate = step(message, candidate, starts);
      if (starts.length >= wanted) return starts;
    }
    const next = page.cursor?.next ?? undefined;
    if (page.data.length < PAGE || next === undefined) break;
    cursor = next;
  }
  if (candidate !== undefined) starts.push(candidate);
  return starts;
}

function step(message: WireMessage, candidate: string | undefined, starts: string[]): string | undefined {
  if (message.type === "user") return message.id;
  if (message.type === "idle" && candidate !== undefined) {
    starts.push(candidate);
    return undefined;
  }
  return candidate;
}

/**
 * The user message to revert to so the last `turns` Tide turns disappear, or undefined when
 * those turns never reached the model. `recorded` is this process's sends, oldest first: the
 * admitted user message id, or undefined when the prompt was refused.
 */
export async function rollbackTarget(api: OpencodeApi, sessionId: string, recorded: readonly (string | undefined)[], turns: number): Promise<string | undefined> {
  if (turns <= recorded.length) return recorded.slice(recorded.length - turns).find((id) => id !== undefined);
  // older than this process: count real turns back from the newest one
  const ran = recorded.filter((id) => id !== undefined).length;
  const wanted = ran + (turns - recorded.length);
  const starts = await turnStartsNewestFirst(api, sessionId, wanted);
  if (starts.length < wanted) throw new Error(`cannot roll back ${turns} turns: the opencode session has ${starts.length - ran + recorded.length}`);
  return starts[wanted - 1];
}
