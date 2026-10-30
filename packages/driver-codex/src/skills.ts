import type { SlashCommandInfo } from "@tide/contracts";
import type { AppServer } from "./app-server.ts";
import type { SkillMetadata } from "./generated/v2/SkillMetadata.ts";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse.ts";

/**
 * Codex slash surface = skills only. The 0.162 app-server bindings expose `skills/list` and
 * no custom-prompt (`~/.codex/prompts`) listing, so nothing else can be offered honestly.
 */
export interface CodexSkill {
  name: string;
  path: string;
  info: SlashCommandInfo;
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
