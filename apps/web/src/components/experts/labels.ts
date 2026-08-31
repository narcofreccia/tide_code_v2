import type { ExpertsSession } from "@tide/contracts";

/** Board authors are expert keys plus the two reserved ids. */
export function authorLabel(session: ExpertsSession, key: string): string {
  if (key === "user") return "You";
  if (key === "lead") return "Lead";
  if (key === "all") return "everyone";
  return session.experts.find((e) => e.key === key)?.name ?? key;
}

export interface RecipientOption {
  value: string;
  label: string;
}

/** `to` choices for the composer: the whole panel, one expert, or the lead. */
export function recipientOptions(session: ExpertsSession): RecipientOption[] {
  return [
    { value: "all", label: "everyone" },
    ...session.experts.map((e) => ({ value: e.key, label: e.name })),
    { value: "lead", label: "Lead" },
  ];
}
