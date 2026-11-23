import type { SlashCommandInfo } from "@tide/contracts";
import type { AppServer } from "./app-server.ts";
import type { SkillMetadata } from "./generated/v2/SkillMetadata.ts";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse.ts";

/**
 * Codex built-in commands Tide maps onto dedicated app-server RPCs (`thread/compact/start`),
 * plus skills discovered via `skills/list`.
 */
export const CODEX_BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "compact", description: "Compact the conversation context now", source: "builtin" },
];

export interface CodexSkill {
  name: string;
  path: string;
  info: SlashCommandInfo;
}

/** True for bare `/compact` (with optional whitespace), routed to `thread/compact/start`. */
export function isCompactCommand(text: string): boolean {
  return /^\/compact\s*$/i.test(text.trimStart());
}

export function toSkills(response: SkillsListResponse | undefined): CodexSkill[] {
  const seen = new Set<string>();
  const out: CodexSkill[] = [];
  for (const entry of response?.data ?? []) {
    for (const skill of entry.skills as SkillMetadata[]) {
      if (skill.enabled === false || seen.has(skill.name)) continue;
      seen.add(skill.name);
      const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
      out.push({ name: skill.name, path: String(skill.path), info: { name: skill.name, ...(description ? { description } : {}), source: "skill" } });
    }
  }
  return out;
}

export async function fetchSkills(server: AppServer, cwd: string, forceReload = false): Promise<CodexSkill[]> {
  return toSkills(await server.request<SkillsListResponse>("skills/list", { cwds: [cwd], ...(forceReload ? { forceReload } : {}) }));
}

const LEADING_SLASH = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

/** `/name rest` -> the listed skill and the remaining text; anything else (unknown names too) stays plain text. */
export function matchSkill(text: string, skills: CodexSkill[]): { skill: CodexSkill; rest: string } | undefined {
  const match = LEADING_SLASH.exec(text.trimStart());
  if (!match) return undefined;
  const skill = skills.find((candidate) => candidate.name === match[1]);
  return skill ? { skill, rest: (match[2] ?? "").trim() } : undefined;
}
