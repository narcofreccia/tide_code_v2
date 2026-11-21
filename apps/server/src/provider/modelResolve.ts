/** One model as a harness lists it (`ProviderStatusDto.models`). */
export interface ListedModel {
  id: string;
  label: string;
}

/**
 * What became of a model id an agent asked for:
 * - `listed`: the harness lists that exact id;
 * - `resolved`: the asked string names exactly one listed model by its id or label once case and
 *   punctuation are dropped (`opus-5.5` → the model labelled "Opus 5.5"); `model` is that id;
 * - `unlisted`: no single match; passed through as asked (harness lists can be partial);
 * - `unknown`: the harness listed nothing, so there is nothing to say either way.
 */
export type ModelResolution =
  | { kind: "listed"; model: string }
  | { kind: "resolved"; asked: string; model: string; label: string }
  | { kind: "unlisted"; model: string }
  | { kind: "unknown"; model: string };

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact or normalised-equal only: a wrong silent substitution is worse than passing the id through. */
export function resolveModel(asked: string, models: readonly ListedModel[]): ModelResolution {
  if (models.length === 0) return { kind: "unknown", model: asked };
  if (models.some((m) => m.id === asked)) return { kind: "listed", model: asked };
  const key = normalise(asked);
  const hits = new Map<string, ListedModel>();
  if (key !== "") {
    for (const m of models) if (normalise(m.id) === key || normalise(m.label) === key) hits.set(m.id, m);
  }
  const [only] = hits.values();
  return hits.size === 1 && only !== undefined ? { kind: "resolved", asked, model: only.id, label: only.label } : { kind: "unlisted", model: asked };
}

/** How many ids a note or hint quotes before it trails off. */
export const MAX_QUOTED_IDS = 16;

/** `a, b, c`, trailing off with `…` past the cap. */
export function quoteIds(ids: readonly string[]): string {
  return `${ids.slice(0, MAX_QUOTED_IDS).join(", ")}${ids.length > MAX_QUOTED_IDS ? ", …" : ""}`;
}

/** The one-line note an agent reads back; undefined when the id was listed or nothing is known. */
export function modelNote(resolution: ModelResolution, harness: string, models: readonly ListedModel[]): string | undefined {
  switch (resolution.kind) {
    case "resolved":
      return `model \`${resolution.asked}\` is not an id ${harness} lists; using \`${resolution.model}\` (${resolution.label})`;
    case "unlisted":
      return `model \`${resolution.model}\` is not in ${harness}'s list (${quoteIds(models.map((m) => m.id))}); passed as is. If the delegate fails on its model, use a listed id`;
    default:
      return undefined;
  }
}
