import type { SettingsSection } from "../../state/ui.ts";

/** What settings search knows about a section: its page header and its row labels. */
export interface SectionMeta {
  title: string;
  blurb: string;
  /** row labels (each row's DOM id derives from its label) plus extra search words */
  keywords: string[];
}

export interface SettingsMatch {
  /** sections whose title, blurb or keywords match, in the given order */
  sections: SettingsSection[];
  /** row labels that match, as "Section › Row" results */
  rows: { section: SettingsSection; label: string }[];
}

function matches(text: string, terms: string[]): boolean {
  const hay = text.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Every whitespace-separated term must appear (case-insensitive) in the text it is matched against. */
export function searchSettings(
  query: string,
  order: readonly SettingsSection[],
  metas: Record<SettingsSection, SectionMeta>,
): SettingsMatch {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { sections: [...order], rows: [] };
  const sections: SettingsSection[] = [];
  const rows: SettingsMatch["rows"] = [];
  for (const section of order) {
    const meta = metas[section];
    const hits = meta.keywords.filter((k) => matches(k, terms));
    if (hits.length > 0 || matches(`${meta.title} ${meta.blurb}`, terms)) sections.push(section);
    for (const label of hits) rows.push({ section, label });
  }
  return { sections, rows };
}
