import type { Activity } from "@tide/contracts";

/**
 * R18: a secret handed to an agent through tide_request_secret must never reach an event. The
 * harness echoes the tool result back as a tool activity, and the agent may repeat the value in
 * a command line, a tool output or its own text. Two layers, both applied by the provider
 * reactor before a command is dispatched, so they hold for every driver:
 *  (a) `redactSecretTool`: the result of the secret tool itself is replaced by a fixed marker,
 *      whatever the harness calls the tool;
 *  (b) `SecretValues`: every value the server handed out is remembered in memory (never
 *      persisted) and scrubbed from any string of any command, including streamed text.
 */

export const SECRET_MARKER = "[secret provided — not recorded]";
export const REDACTED = "[redacted]";
/** shorter values are not scrubbed: replacing them would mangle ordinary text */
export const MIN_SECRET_LENGTH = 6;

// mcp__tide__tide_request_secret (Claude), mcp:tide.tide_request_secret (Codex),
// tide_tide_request_secret (OpenCode), tide/tide_request_secret, "Tide: request secret" (ACP titles)
const SECRET_TOOL = /tide[\W_]*request[\W_]*secret/i;

function titleOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const title = (input as Record<string, unknown>)["title"];
  return typeof title === "string" ? title : undefined;
}

/** A tool row of tide_request_secret, by name or (ACP) by the title it was given. */
export function isSecretToolActivity(activity: Activity): boolean {
  if (activity.kind !== "tool") return false;
  return SECRET_TOOL.test(activity.toolName) || SECRET_TOOL.test(titleOf(activity.input) ?? "");
}

const DECLINED = /declined to provide/;
const FILE = /The user provided [A-Z0-9_]+\. It is in the file /;
const PROVIDED = /The user provided ([A-Z0-9_]+)\./;

/**
 * Layer (a): the output of a tide_request_secret row is replaced, whatever update carries it.
 * Declined and file results hold no value and stay readable; so does a failed call (its text is
 * an argument error). Applied after `mergeActivity`, so a row whose name arrived in an earlier
 * update is still matched.
 */
export function redactSecretTool(activity: Activity): Activity {
  if (activity.kind !== "tool" || activity.output === undefined || !isSecretToolActivity(activity)) return activity;
  const output = activity.output;
  if (output === SECRET_MARKER || output.endsWith(` ${SECRET_MARKER}`)) return activity;
  if (activity.status === "error" || DECLINED.test(output) || FILE.test(output)) return activity;
  const name = PROVIDED.exec(output)?.[1];
  return { ...activity, output: name === undefined ? SECRET_MARKER : `The user provided ${name}. ${SECRET_MARKER}` };
}

/** The forms a value may take in a record: as is, and JSON-escaped inside a serialized result. */
function formsOf(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
}

/**
 * Layer (b): the values handed to agents, per thread, in memory only. Scrubbing matches every
 * remembered value on every thread (an agent can pass a value on to another thread); `forget`
 * drops a thread's values when it is archived or deleted.
 *
 * Streamed text (`stream`) keeps a small carry-over per message: the tail of a chunk that could
 * be the start of a value is held back until the next chunk decides it, so a value split across
 * deltas is still caught. Held text is released by `flush` when the turn settles. Limits: a value
 * shorter than MIN_SECRET_LENGTH is not scrubbed; a value transformed by the agent (encoded,
 * reversed, split by other text) is not recognized; an activity field that arrives in pieces
 * across several upserts is matched on the merged field, which a driver resends whole.
 */
export class SecretValues {
  #byThread = new Map<string, Set<string>>();
  #patterns: string[] = [];
  /** `${kind}|${messageKey}` -> text held back from the stream */
  #held = new Map<string, string>();

  remember(threadId: string, value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    let set = this.#byThread.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.#byThread.set(threadId, set);
    }
    set.add(value);
    this.#rebuild();
  }

  forget(threadId: string): void {
    if (this.#byThread.delete(threadId)) this.#rebuild();
  }

  /** whether any value is remembered (for the thread, when given) */
  has(threadId?: string): boolean {
    return threadId === undefined ? this.#patterns.length > 0 : (this.#byThread.get(threadId)?.size ?? 0) > 0;
  }

  #rebuild(): void {
    const all = new Set<string>();
    for (const set of this.#byThread.values()) for (const value of set) for (const form of formsOf(value)) all.add(form);
    // longest first, so a value containing another is replaced whole
    this.#patterns = [...all].sort((a, b) => b.length - a.length);
  }

  scrubText(text: string): string {
    let out = text;
    for (const pattern of this.#patterns) if (out.includes(pattern)) out = out.split(pattern).join(REDACTED);
    return out;
  }

  /** Every string inside `value`, scrubbed; the same object back when nothing matched. */
  scrub<T>(value: T): T {
    if (this.#patterns.length === 0) return value;
    return this.#deep(value) as T;
  }

  #deep(value: unknown): unknown {
    if (typeof value === "string") return this.scrubText(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const out = this.#deep(item);
        if (out !== item) changed = true;
        return out;
      });
      return changed ? next : value;
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const out = this.#deep(item);
        if (out !== item) changed = true;
        next[key] = out;
      }
      return changed ? next : value;
    }
    return value;
  }

  /**
   * One streamed chunk of `kind` text for message `key` (`${turnId}:${messageKey}`): returns
   * what may be emitted now, scrubbed, holding back a tail that could start a value.
   */
  stream(kind: string, key: string, delta: string): string {
    const slot = `${kind}|${key}`;
    const held = this.#held.get(slot);
    if (this.#patterns.length === 0 && held === undefined) return delta;
    this.#held.delete(slot);
    const text = this.scrubText((held ?? "") + delta);
    const keep = this.#pendingTail(text);
    if (keep === 0) return text;
    this.#held.set(slot, text.slice(text.length - keep));
    return text.slice(0, text.length - keep);
  }

  /** Length of the longest tail of `text` that is a proper prefix of a remembered value. */
  #pendingTail(text: string): number {
    let best = 0;
    for (const pattern of this.#patterns) {
      const first = pattern[0];
      for (let i = Math.max(0, text.length - pattern.length + 1); i < text.length - best; i++) {
        if (text[i] !== first) continue;
        if (pattern.startsWith(text.slice(i))) {
          best = text.length - i;
          break;
        }
      }
    }
    return best;
  }

  /** Releases (and forgets) the text held for every message of `turnId`. */
  flush(turnId: string): { kind: string; key: string; text: string }[] {
    const out: { kind: string; key: string; text: string }[] = [];
    for (const [slot, text] of this.#held) {
      const bar = slot.indexOf("|");
      const key = slot.slice(bar + 1);
      if (!key.startsWith(`${turnId}:`)) continue;
      this.#held.delete(slot);
      if (text !== "") out.push({ kind: slot.slice(0, bar), key, text: this.scrubText(text) });
    }
    return out;
  }
}

const perEngine = new WeakMap<object, SecretValues>();

/**
 * The registry shared by everything built on one engine (the secret RPC handlers remember,
 * the provider reactor scrubs), without threading it through the RPC server's wiring.
 */
export function secretValuesFor(engine: object): SecretValues {
  let values = perEngine.get(engine);
  if (values === undefined) {
    values = new SecretValues();
    perEngine.set(engine, values);
  }
  return values;
}
