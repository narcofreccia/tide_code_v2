/**
 * Wording for Claude Code's context compaction rows. The web recognises these
 * prefixes ("Compacting conversation", "Context compacted") to draw the notice, so
 * every driver that reports compaction uses the same words.
 */
export const COMPACTING_TEXT = "Compacting conversation…";

/** 182_400 -> "182k", 950 -> "950", 1_200_000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

const count = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);

/** "Context compacted (manual) · 182k → 21k tokens"; the token part only when the CLI sent it. */
export function compactedText(meta: { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined): string {
  const head = `Context compacted (${meta?.trigger ?? "auto"})`;
  const pre = count(meta?.pre_tokens);
  const post = count(meta?.post_tokens);
  if (pre !== undefined && post !== undefined) return `${head} · ${formatTokens(pre)} → ${formatTokens(post)} tokens`;
  if (pre !== undefined) return `${head} · from ${formatTokens(pre)} tokens`;
  return head;
}
