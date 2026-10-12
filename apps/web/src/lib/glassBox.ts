/** `12.4k` / `980` — token counts in footers and tooltips. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Hover text for a `ctx N%` figure: the raw numbers behind the percentage. */
export function contextTitle(context: { used: number; window: number }): string {
  return `${context.used.toLocaleString("en-US")} / ${context.window.toLocaleString("en-US")} tokens of context used`;
}

/** `$0.42` above a cent, `<$0.01` below it, `$0` for nothing. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
