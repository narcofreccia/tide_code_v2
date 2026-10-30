import { describe, expect, it } from "vitest";
import { searchSettings, type SectionMeta } from "./search.ts";
import type { SettingsSection } from "../../state/ui.ts";

const meta = (title: string, keywords: string[]): SectionMeta => ({ title, blurb: `${title} blurb`, keywords });
const METAS = {
  general: meta("General", ["Follow-up default"]),
  git: meta("Git", ["Merge back strategy", "Delete the branch after merging"]),
} as unknown as Record<SettingsSection, SectionMeta>;
const ORDER = ["general", "git"] as SettingsSection[];

describe("settings search", () => {
  it("returns every section for an empty query", () => {
    expect(searchSettings("  ", ORDER, METAS)).toEqual({ sections: ORDER, rows: [] });
  });

  it("matches row labels across sections, every term, any case", () => {
    expect(searchSettings("BRANCH merg", ORDER, METAS)).toEqual({
      sections: ["git"],
      rows: [{ section: "git", label: "Delete the branch after merging" }],
    });
  });

  it("matches a section by its title without row hits", () => {
    expect(searchSettings("general", ORDER, METAS)).toEqual({ sections: ["general"], rows: [] });
  });
});
