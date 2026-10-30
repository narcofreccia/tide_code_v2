import type { ProviderKind } from "@tide/contracts";
import type { UsageTokens } from "./types.ts";

/** Usage summed per local day × provider × instance × model × source; rows and days are both folds of these. */
export interface Bucket {
  day: string;
  provider: ProviderKind;
  providerId?: string;
  model?: string;
  source: "tide" | "external";
  tokens: UsageTokens;
  /** sum of the costs that were reported */
  cost: number;
  /** how many of `count` reported a cost */
  reported: number;
  count: number;
}

/** YYYY-MM-DD in the server's zone */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class BucketSet {
  #map = new Map<string, Bucket>();

  add(entry: { at: number; provider: ProviderKind; providerId?: string | undefined; model?: string | undefined; source: "tide" | "external"; tokens: UsageTokens; costUsd?: number | undefined }): void {
    const day = localDay(entry.at);
    const key = [day, entry.provider, entry.providerId ?? "", entry.model ?? "", entry.source].join("\u0000");
    let b = this.#map.get(key);
    if (!b) {
      b = {
        day,
        provider: entry.provider,
        source: entry.source,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        reported: 0,
        count: 0,
        ...(entry.providerId !== undefined ? { providerId: entry.providerId } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
      };
      this.#map.set(key, b);
    }
    b.tokens.in += entry.tokens.in;
    b.tokens.out += entry.tokens.out;
    b.tokens.cacheRead += entry.tokens.cacheRead;
    b.tokens.cacheWrite += entry.tokens.cacheWrite;
    b.count++;
    if (entry.costUsd !== undefined) {
      b.cost += entry.costUsd;
      b.reported++;
    }
  }

  list(): Bucket[] {
    return [...this.#map.values()];
  }
}
