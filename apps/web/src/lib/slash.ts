import type { SlashCommandInfo } from "@tide/contracts";

/**
 * `/command` in the composer. Harnesses only execute commands at the start of the
 * message — `a/b`, `see /tmp`, and line-2 `/cmd` are prose — and Tide inserts the
 * name and sends the text as typed.
 */
export interface SlashQuery {
  /** index of the `/` */
  start: number;
  /** text between the `/` and the caret */
  query: string;
}

/** The `/…` token the caret sits in, only when it opens the message (line 1). */
export function findSlashQuery(text: string, caret: number): SlashQuery | undefined {
  if (text[0] !== "/" || caret < 1) return undefined;
  const query = text.slice(1, caret);
  if (/\s/.test(query)) return undefined;
  return { start: 0, query };
}

/** `review` and `/review` name the same command. */
export function commandName(command: SlashCommandInfo): string {
  return command.name.replace(/^\//, "");
}

/** Prefix matches, case-insensitive, in the harness's own order; an empty query lists everything. */
export function filterCommands(commands: readonly SlashCommandInfo[], query: string, limit = 50): SlashCommandInfo[] {
  const q = query.toLowerCase();
  return commands.filter((c) => commandName(c).toLowerCase().startsWith(q)).slice(0, limit);
}

/** Replaces the in-progress `/query` with `/name ` and returns the new caret. */
export function applySlash(text: string, slash: SlashQuery, caret: number, name: string): { text: string; caret: number } {
  const next = `${text.slice(0, slash.start)}/${name} ${text.slice(caret)}`;
  return { text: next, caret: slash.start + name.length + 2 };
}

/**
 * The command the text opens with that this harness does not list, if any
 * (`/fooo bar` → `fooo`). Undefined for prose and for a known command or prefix.
 */
export function unknownCommand(text: string, commands: readonly SlashCommandInfo[]): string | undefined {
  const match = /^\/(\S+)/.exec(text);
  const token = match?.[1];
  if (token === undefined) return undefined;
  return filterCommands(commands, token, 1).length > 0 ? undefined : token;
}

export const SOURCE_LABELS: Record<SlashCommandInfo["source"], string> = {
  builtin: "built-in",
  custom: "custom",
  skill: "skill",
};

/** R16: Tide's own commands, listed in the `/` picker beside the harness's. */
export const TIDE_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "side", description: "Side chat (Tide)", argumentHint: "<question>", source: "builtin" },
  { name: "btw", description: "Side chat (Tide)", argumentHint: "<question>", source: "builtin" },
  { name: "clear", description: "Next message starts a new harness session (Tide)", source: "builtin" },
];

/** True for a name Tide handles itself (`/side`, `/btw`), never sent to the harness. */
export function isTideCommand(name: string): boolean {
  return TIDE_COMMANDS.some((c) => c.name === name);
}

/**
 * `/side <prompt>` / `/btw <prompt>`: the whole message asks a side chat. The bare command
 * opens an empty one (`prompt: ""`); anything else (`/sidebar`, prose) is undefined.
 */
export function parseSideCommand(text: string): { prompt: string } | undefined {
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { prompt: (match[2] ?? "").trim() };
}

/** `/clear` arms a fresh session; `/clear <prompt>` also sends the prompt in it. Anything else is undefined. */
export function parseClearCommand(text: string): { rest: string } | undefined {
  const match = /^\/clear(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { rest: (match[1] ?? "").trim() };
}
