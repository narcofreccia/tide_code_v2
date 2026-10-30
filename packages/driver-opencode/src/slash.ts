import type { SlashCommandInfo } from "@tide/contracts";
import type { SkillAttachment, WireCommand, WireSkill } from "./wire.ts";

export interface SlashCatalog {
  commands: WireCommand[];
  skills: WireSkill[];
}

/** Custom commands first (they win a name clash), then skills (`autoinvoke`-only ones included: `/name` still loads them). */
export function toSlashCommands(catalog: SlashCatalog): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = catalog.commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    source: "custom" as const,
  }));
  for (const skill of catalog.skills) {
    if (out.some((entry) => entry.name === skill.name)) continue;
    out.push({ name: skill.name, ...(skill.description ? { description: skill.description } : {}), source: "skill" });
  }
  return out;
}

export type SlashRoute =
  | { kind: "command"; name: string; text: string }
  | { kind: "skill"; skill: SkillAttachment; text: string }
  | { kind: "prompt"; text: string };

/**
 * `/name args` → `POST …/command {name, text: args}` for a listed custom command, a prompt with
 * a skill attachment for a listed skill, otherwise the text unchanged (pass-through: the harness
 * decides what an unknown `/x` means).
 */
export function routeSlash(text: string, catalog: SlashCatalog): SlashRoute {
  const trimmed = text.trimStart();
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: "prompt", text };
  const name = match[1]!;
  const rest = (match[2] ?? "").trim();
  if (catalog.commands.some((command) => command.name === name)) return { kind: "command", name, text: rest };
  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (skill) return { kind: "skill", skill: { id: skill.id, mention: { start: 0, end: name.length + 1, text: `/${name}` } }, text: trimmed };
  return { kind: "prompt", text };
}
