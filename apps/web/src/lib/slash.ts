import type { SlashCommandInfo } from "@tide/contracts";

/**
 * `/command` in the composer. A command is only a command at the start of the
 * text or of a line — `a/b` and `see /tmp` are prose — and the harness runs it:
 * Tide inserts the name and sends the text as typed.
 */
export interface SlashQuery {
  /** index of the `/` */
  start: number;
  /** text between the `/` and the caret */
  query: string;
}

/** The `/…` token the caret sits in, when it opens the text or a line. */
export function findSlashQuery(text: string, caret: number): SlashQuery | undefined {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  if (text[lineStart] !== "/") return undefined;
  const query = text.slice(lineStart + 1, caret);
  if (/\s/.test(query)) return undefined;
  return { start: lineStart, query };
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
