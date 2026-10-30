import type { UsageTokens } from "./types.ts";

/**
 * Tide's ESTIMATES of API list prices, never the bill. Subscriptions (Claude Max, ChatGPT
 * plans) are not billed per token at all; the usage page labels every figure from this table
 * as an estimate and shows a harness-reported cost separately when one exists.
 *
 * USD per million tokens. `in` is uncached input; cache reads/writes are priced on their own.
 * Anthropic rows: first-party list prices (cache write = 5-minute TTL, 1.25x input). OpenAI rows
 * are approximate and unverified. OpenCode's free tier (`opencode/*`) is 0.
 *
 * To update: edit the rows, bump PRICING_VERSION (the page shows it next to every estimate),
 * run `vitest run src/usage/pricing.test.ts`. Exact ids win; then a dated/suffixed id of a row
 * (`<row>-…`); then the longest matching prefix in FAMILIES. An unknown model gets no
 * estimate (undefined), never a guess.
 */
export const PRICING_VERSION = "2026-10";

export interface Price {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, out: number, cacheRead: number, cacheWrite: number): Price => ({ in: input, out, cacheRead, cacheWrite });

export const MODELS: Readonly<Record<string, Price>> = {
  "claude-fable-5-1": p(10, 50, 0.25, 12.5),
  "claude-fable-5": p(10, 50, 1, 12.5),
  "claude-opus-5-5": p(4, 20, 0.2, 5),
  "claude-opus-5": p(5, 25, 0.5, 6.25),
  "claude-opus-4-8": p(5, 25, 0.5, 6.25),
  "claude-opus-4-7": p(5, 25, 0.5, 6.25),
  "claude-opus-4-6": p(5, 25, 0.5, 6.25),
  "claude-sonnet-5-5": p(2, 10, 0.2, 2.5),
  "claude-sonnet-5": p(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": p(3, 15, 0.3, 3.75),
  "claude-haiku-5-5": p(0.1, 0.5, 0.01, 0.125),
  "claude-haiku-4-5": p(1, 5, 0.1, 1.25),
  "gpt-6.1-sol": p(5, 40, 0.5, 0),
  "gpt-6.1": p(2.5, 20, 0.25, 0),
  "gpt-6-luna": p(1.25, 10, 0.125, 0),
};

/** longest prefix wins; covers dated ids, `[1m]` suffixes and minor versions the table lacks */
export const FAMILIES: readonly (readonly [prefix: string, price: Price])[] = [
  ["claude-fable", p(10, 50, 0.25, 12.5)],
  ["claude-mythos", p(10, 50, 0.25, 12.5)],
  ["claude-opus", p(4, 20, 0.2, 5)],
  ["claude-sonnet", p(2, 10, 0.2, 2.5)],
  ["claude-haiku", p(0.1, 0.5, 0.01, 0.125)],
  ["gpt-6.1", p(2.5, 20, 0.25, 0)],
  ["gpt-6", p(1.25, 10, 0.125, 0)],
  ["gpt-5", p(1.25, 10, 0.125, 0)],
  ["opencode/", p(0, 0, 0, 0)],
];

/** `anthropic/claude-x`, `anthropic.claude-x`, `openai/gpt-x` → bare id; `opencode/` stays (it marks the free tier) */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/^(anthropic|openai|openrouter\/[a-z-]+|us\.anthropic|eu\.anthropic)[./]/, "");
  return m.replace(/\[[^\]]*\]$/, "");
}

export interface PriceMatch {
  price: Price;
  /** exact table row, or a family fallback */
  basis: "exact" | "family";
}

export function priceFor(model: string | undefined): PriceMatch | undefined {
  if (model === undefined || model.length === 0) return undefined;
  const m = normalizeModel(model);
  const exact = MODELS[m];
  if (exact !== undefined) return { price: exact, basis: "exact" };
  // a dated or suffixed id of a table row (`claude-haiku-4-5-20251001`) takes that row, not the family's
  let row: string | undefined;
  for (const key of Object.keys(MODELS)) if (m.startsWith(`${key}-`) && (row === undefined || key.length > row.length)) row = key;
  if (row !== undefined) return { price: MODELS[row] as Price, basis: "family" };
  let best: (typeof FAMILIES)[number] | undefined;
  for (const f of FAMILIES) if (m.startsWith(f[0]) && (best === undefined || f[0].length > best[0].length)) best = f;
  return best !== undefined ? { price: best[1], basis: "family" } : undefined;
}

/** USD estimate for these tokens on this model; undefined when the model is not in the table. */
export function estimate(model: string | undefined, tokens: UsageTokens): number | undefined {
  const match = priceFor(model);
  if (!match) return undefined;
  const { price } = match;
  return (tokens.in * price.in + tokens.out * price.out + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000;
}
