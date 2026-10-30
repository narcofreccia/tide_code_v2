import type { ProviderInstanceConfig, ProviderKind } from "@tide/contracts";
import { BUNDLED_PROVIDERS, PROVIDER_LABELS } from "../../../lib/vocab.ts";

/** `Work account` → `work-account`; never empty. */
export function slug(label: string): string {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s === "" ? "account" : s;
}

/**
 * `"<kind>:<slug>"`, made unique against `taken` with `-2`, `-3`…; never a bare
 * bundled kind (the server refuses ids that shadow a default instance).
 */
export function instanceId(kind: ProviderKind, name: string, taken: readonly string[]): string {
  // "Codex · work" → codex:work, not codex:codex-work
  const prefix = `${slug(PROVIDER_LABELS[kind])}-`;
  const named = slug(name);
  const tail = named.startsWith(prefix) && named.length > prefix.length ? named.slice(prefix.length) : named;
  const base = `${kind}:${tail}`.slice(0, 60);
  const used = new Set<string>([...taken, ...BUNDLED_PROVIDERS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!used.has(next)) return next;
  }
}

/** `KEY=VALUE` per line; blank lines and `#` comments are skipped. Returns the bad lines too. */
export function parseEnv(text: string): { env: Record<string, string>; invalid: string[] } {
  const env: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalid.push(line);
      continue;
    }
    env[key] = line.slice(eq + 1).trim();
  }
  return { env, invalid };
}

export function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Shell-ish split: whitespace separates, double or single quotes group. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function joinArgs(args: readonly string[] | undefined): string {
  return (args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

/** The editable fields of one instance, as strings. */
export interface InstanceDraft {
  label: string;
  home: string;
  env: string;
  binaryPath: string;
  command: string;
  args: string;
}

export function draftOf(instance: ProviderInstanceConfig | undefined): InstanceDraft {
  return {
    label: instance?.label ?? "",
    home: instance?.home ?? "",
    env: formatEnv(instance?.env),
    binaryPath: instance?.binaryPath ?? "",
    command: instance?.command ?? "",
    args: joinArgs(instance?.args),
  };
}

/** Why the draft cannot be saved, if it cannot. */
export function draftProblem(draft: InstanceDraft, kind: ProviderKind, needsCommand: boolean): string | undefined {
  if (draft.label.trim() === "") return "Name it";
  if (draft.label.trim().length > 80) return "Keep the name under 80 characters";
  const { invalid } = parseEnv(draft.env);
  if (invalid.length > 0) return `Not KEY=VALUE: ${invalid[0]}`;
  if (kind === "acp" && needsCommand && draft.command.trim() === "") return "Give the command that starts the agent";
  return undefined;
}

/**
 * The config to store. Keeps `id`, `kind` and `acpAgentId` of the edited instance;
 * empty fields are left out rather than stored as "".
 */
export function configFromDraft(
  base: Pick<ProviderInstanceConfig, "id" | "kind"> & { acpAgentId?: string | undefined },
  draft: InstanceDraft,
): ProviderInstanceConfig {
  const { env } = parseEnv(draft.env);
  const args = splitArgs(draft.args);
  const home = draft.home.trim();
  const binaryPath = draft.binaryPath.trim();
  const command = draft.command.trim();
  return {
    id: base.id,
    kind: base.kind,
    label: draft.label.trim(),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(home === "" ? {} : { home }),
    ...(binaryPath === "" ? {} : { binaryPath }),
    ...(base.acpAgentId === undefined ? {} : { acpAgentId: base.acpAgentId }),
    ...(command === "" ? {} : { command }),
    ...(args.length === 0 ? {} : { args }),
  };
}
