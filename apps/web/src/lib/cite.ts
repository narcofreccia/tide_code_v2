/**
 * The composer's `window` event (R11 shape). `detail` is either the legacy string
 * (replaces the text) or `{ text, mode }`; it never sends.
 */
export const COMPOSE_EVENT = "tide:compose";

export type ComposeMode = "replace" | "append";
export interface ComposeDetail {
  text: string;
  mode: ComposeMode;
}

export const CITE_LIMIT = 2_000;

export function readComposeDetail(detail: unknown): ComposeDetail | undefined {
  if (typeof detail === "string") return { text: detail, mode: "replace" };
  if (typeof detail !== "object" || detail === null) return undefined;
  const { text, mode } = detail as { text?: unknown; mode?: unknown };
  if (typeof text !== "string") return undefined;
  return { text, mode: mode === "append" ? "append" : "replace" };
}

/** Puts text in the composer (it does not send). */
export function compose(text: string, mode: ComposeMode = "replace"): void {
  window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { text, mode } }));
}

/** Appends after a blank line, or replaces. */
export function applyCompose(current: string, detail: ComposeDetail): string {
  if (detail.mode === "replace") return detail.text;
  const head = current.trimEnd();
  return head === "" ? detail.text : `${head}\n\n${detail.text}`;
}

/** `> line` per line, trimmed to the cite limit, then `— from <label>` and a blank line to type after. */
export function citeBlock(selected: string, label: string | undefined): string {
  let text = selected.trim();
  if (text.length > CITE_LIMIT) text = `${text.slice(0, CITE_LIMIT).trimEnd()}…`;
  const quoted = text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const from = label === undefined || label === "" ? "" : `\n— from ${label}`;
  return `${quoted}${from}\n\n`;
}

/** Appends a citation of `selected` to the open composer and focuses it. */
export function cite(selected: string, label?: string): void {
  if (selected.trim() === "") return;
  compose(citeBlock(selected, label), "append");
}
