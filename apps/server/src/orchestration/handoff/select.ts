import type { HandoffStrategy, ProviderKind, ReadModel, Turn } from "@tide/contracts";

/**
 * Portable context for a harness that has not seen the thread (provider switch, fork onto a
 * harness that cannot fork natively). Ported from T3 Code's handoff: a *budgeted selection of
 * verbatim history*, never a model-written summary — what the agent reads is exactly what the
 * user and the previous harness wrote. Whole items only: an item that does not fit is omitted
 * and the agent is told how to fetch it.
 */

const DEFAULT_CAP = 16_000;
const MIN_CAP = 1_024;
const MAX_CAP = 64_000;
const DEFAULT_WINDOW = 128_000;
const MIN_RESERVE = 16_000;
/** longest single item kept verbatim; beyond this the tail is cut and marked */
const MAX_ITEM_CHARS = 4_000;
const TOOL_OUTPUT_CHARS = 600;

export interface HandoffBudgetOptions {
  /** `TIDE_HANDOFF_TOKEN_CAP`; 1 token is charged per UTF-8 byte so the bound is conservative */
  cap?: number | string | undefined;
  /** the target model's context window when known */
  window?: number | undefined;
}

/** Bytes available for history: never more than the cap, never into the reserve the harness needs for tools, instructions and work. */
export function handoffBudget(options: HandoffBudgetOptions = {}): number {
  const raw = typeof options.cap === "string" ? Number.parseInt(options.cap, 10) : options.cap;
  const cap = Number.isFinite(raw) && raw !== undefined ? Math.min(MAX_CAP, Math.max(MIN_CAP, raw)) : DEFAULT_CAP;
  const window = options.window !== undefined && options.window > 0 ? options.window : DEFAULT_WINDOW;
  const reserve = Math.max(MIN_RESERVE, Math.floor(window / 4));
  return Math.max(0, Math.min(cap, window - reserve));
}

interface Item {
  turnId: string;
  turnIndex: number;
  /** position inside the thread's timeline (chronological tiebreak) */
  pos: number;
  kind: "user" | "assistant" | "command" | "files" | "error" | "plan";
  text: string;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+$/u, "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const FILE_TOOLS = /^(edit|write|multiedit|create|notebookedit|str_replace_editor|apply_patch|patch)$/i;
const SHELL_TOOLS = /^(bash|shell|exec|run|terminal|execute_command|shell_command|local_shell)$/i;

function inputPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "filePath", "filename"]) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}
function inputCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o["command"] === "string") return o["command"] as string;
  if (Array.isArray(o["command"])) return (o["command"] as unknown[]).map(String).join(" ");
  if (typeof o["cmd"] === "string") return o["cmd"] as string;
  return undefined;
}

/** Everything a later harness may need, in thread order, limited to `turns`. */
export function collectItems(model: ReadModel, threadId: string, turns: Turn[]): Item[] {
  const index = new Map(turns.map((t, i) => [t.id, i]));
  const items: Item[] = [];
  const timeline = model.threadTimeline[threadId] ?? [];
  timeline.forEach((entry, pos) => {
    if (entry.kind === "message") {
      const m = model.messages[entry.id];
      const turnIndex = m === undefined ? undefined : index.get(m.turnId);
      if (!m || turnIndex === undefined || m.text.trim() === "") return;
      items.push({ turnId: m.turnId, turnIndex, pos, kind: m.role === "user" ? "user" : "assistant", text: clip(m.text, MAX_ITEM_CHARS) });
      return;
    }
    if (entry.kind === "plan") {
      const p = model.plans[entry.id];
      const turnIndex = p === undefined ? undefined : index.get(p.turnId);
      if (!p || turnIndex === undefined) return;
      items.push({ turnId: p.turnId, turnIndex, pos, kind: "plan", text: clip(p.markdown, MAX_ITEM_CHARS) });
      return;
    }
    const a = model.activities[entry.id];
    const turnIndex = a === undefined ? undefined : index.get(a.turnId);
    if (!a || turnIndex === undefined) return;
    if (a.kind === "error") {
      items.push({ turnId: a.turnId, turnIndex, pos, kind: "error", text: clip(a.text, TOOL_OUTPUT_CHARS) });
      return;
    }
    if (a.kind !== "tool") return;
    if (SHELL_TOOLS.test(a.toolName)) {
      const cmd = inputCommand(a.input);
      if (cmd === undefined) return;
      const out = a.output === undefined ? "" : `\n${clip(a.output, TOOL_OUTPUT_CHARS)}`;
      items.push({ turnId: a.turnId, turnIndex, pos, kind: "command", text: `$ ${clip(cmd, 400)} (${a.status})${out}` });
      return;
    }
    if (FILE_TOOLS.test(a.toolName)) {
      const path = inputPath(a.input);
      if (path !== undefined) items.push({ turnId: a.turnId, turnIndex, pos, kind: "files", text: path });
    }
  });
  return items;
}

const LABEL: Record<Item["kind"], string> = {
  user: "Historical user",
  assistant: "Historical assistant",
  command: "Command run",
  files: "File changed",
  error: "Error",
  plan: "Proposed plan",
};

function render(item: Item, turnNo: number): string {
  return `[${LABEL[item.kind]}; turn=${turnNo}]\n${item.text}\n`;
}

export interface HandoffSelection {
  text: string;
  coveredTurnIds: string[];
  omittedTurnIds: string[];
}

export interface SelectHandoffOptions {
  threadId: string;
  toProvider: ProviderKind;
  strategy: HandoffStrategy;
  /** the turns to cover, oldest first (already filtered: settled, not rolled back, after the delta point) */
  turns: Turn[];
  budgetBytes: number;
  /** the thread the history belongs to (differs from threadId on a fork) */
  sourceTitle: string;
}

/**
 * Picks whole items into the budget: the latest user request, the latest answer, the original
 * request, then newest to oldest. Renders them in chronological order with a coverage header
 * and instructions for fetching what was left out.
 */
export function selectHandoff(model: ReadModel, options: SelectHandoffOptions): HandoffSelection {
  const { turns } = options;
  const items = collectItems(model, options.threadId, turns);
  const turnNo = new Map(turns.map((t, i) => [t.id, i + 1]));
  const size = (item: Item): number => Buffer.byteLength(render(item, turnNo.get(item.turnId) ?? 0), "utf8");

  const priority: Item[] = [];
  const lastUser = [...items].reverse().find((i) => i.kind === "user");
  const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant");
  const firstUser = items.find((i) => i.kind === "user");
  for (const i of [lastUser, lastAssistant, firstUser]) if (i && !priority.includes(i)) priority.push(i);
  const rest = [...items].reverse().filter((i) => !priority.includes(i));

  const chosen = new Set<Item>();
  let used = 0;
  for (const item of [...priority, ...rest]) {
    const bytes = size(item);
    if (used + bytes > options.budgetBytes) continue;
    chosen.add(item);
    used += bytes;
  }

  const withItems = new Set(items.map((i) => i.turnId));
  const covered = new Set([...chosen].map((i) => i.turnId));
  const coveredTurnIds = turns.filter((t) => covered.has(t.id)).map((t) => t.id);
  const omittedTurnIds = turns.filter((t) => withItems.has(t.id) && !covered.has(t.id)).map((t) => t.id);
  const body = [...chosen].sort((a, b) => a.pos - b.pos).map((i) => render(i, turnNo.get(i.turnId) ?? 0)).join("\n");

  const omittedItems = items.length - chosen.size;
  const header = [
    options.strategy === "delta"
      ? `# Context handoff (delta): what happened on this thread since you last worked on it`
      : `# Context handoff: history of thread "${options.sourceTitle}"`,
    `Verbatim excerpts, oldest first, covering ${coveredTurnIds.length} of ${turns.length} turn(s).` +
      (omittedItems > 0 ? ` ${omittedItems} item(s) did not fit the budget.` : ""),
    omittedItems > 0 ? `Call the Tide tool \`tide_thread_read\` (view "activity") on this thread for anything omitted. Working state (tool results, your previous reasoning) is not carried over.` : `Working state (tool results, previous reasoning) is not carried over.`,
    `Continue from the user's next message below.`,
  ].join("\n");
  return { text: `${header}\n\n${body}`.trimEnd(), coveredTurnIds, omittedTurnIds };
}

/** The settled, surviving turns of a thread, oldest first; `sinceTurnId` keeps only what came after it, `untilTurnId` stops there (inclusive). */
export function handoffTurns(model: ReadModel, threadId: string, range: { sinceTurnId?: string | undefined; untilTurnId?: string | undefined } = {}): Turn[] {
  const all = Object.values(model.turns)
    .filter((t) => t.threadId === threadId && t.status !== "queued" && !t.rolledBack)
    .sort((a, b) => a.requestedAt - b.requestedAt);
  const since = range.sinceTurnId === undefined ? -1 : all.findIndex((t) => t.id === range.sinceTurnId);
  const until = range.untilTurnId === undefined ? all.length - 1 : all.findIndex((t) => t.id === range.untilTurnId);
  return all.slice(since + 1, (until < 0 ? all.length - 1 : until) + 1);
}
