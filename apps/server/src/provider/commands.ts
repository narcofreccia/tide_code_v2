import type { SlashCommandInfo } from "@tide/contracts";

const TTL_MS = 30_000;

interface Cached {
  at: number;
  commands: SlashCommandInfo[];
  /** pushed by a live session (`commands` event): authoritative until the next push */
  live: boolean;
}

/**
 * R8: slash commands + skills per (instance, cwd), for the composer's `/` picker. A list a live
 * session announced (ACP `available_commands_update`, Codex skills changed) wins over a polled
 * `listCommands` and does not expire; a polled one lives 30 s.
 */
export class CommandsCache {
  #entries = new Map<string, Cached>();
  #now: () => number;
  #ttl: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttl = options.ttlMs ?? TTL_MS;
  }

  get(providerId: string, cwd: string): SlashCommandInfo[] | undefined {
    const hit = this.#entries.get(key(providerId, cwd));
    if (!hit) return undefined;
    if (!hit.live && this.#now() - hit.at >= this.#ttl) return undefined;
    return hit.commands;
  }

  put(providerId: string, cwd: string, commands: SlashCommandInfo[], live = false): void {
    const k = key(providerId, cwd);
    // a poll never overwrites what the session itself said
    if (!live && this.#entries.get(k)?.live) return;
    this.#entries.set(k, { at: this.#now(), commands, live });
  }
}

const key = (providerId: string, cwd: string): string => `${providerId}\u0000${cwd}`;
