export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * `--- a//repo/x.ts` → `--- /repo/x.ts`: drops git's `a/` `b/` side prefixes from
 * file header lines and collapses the doubled slash an absolute path leaves behind.
 */
export function cleanDiffHeader(text: string): string {
  let out = text;
  if (out.startsWith("--- ") || out.startsWith("+++ ")) out = `${out.slice(0, 4)}${out.slice(4).replace(/^[ab]\//, "")}`;
  else if (out.startsWith("diff --git ")) out = out.replace(/ [ab]\//g, " ");
  else return out;
  return out.replace(/\/{2,}/g, "/");
}

/** Classifies a unified diff line by line; no patch semantics, just colouring. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  return lines.map((text) => {
    if (text.startsWith("@@")) return { kind: "hunk" as const, text };
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index "))
      return { kind: "meta" as const, text: cleanDiffHeader(text) };
    if (text.startsWith("+")) return { kind: "add" as const, text };
    if (text.startsWith("-")) return { kind: "del" as const, text };
    return { kind: "context" as const, text };
  });
}

/** `+12 −3` counters for a diff preview header. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

/**
 * Line number of the first changed line on the new side, read from the patch's
 * first hunk header (`@@ -a,b +c,d @@`). Used by "Open in editor".
 */
export function firstChangedLine(patch: string | undefined): number {
  if (!patch) return 1;
  for (const line of patch.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (match) return Math.max(1, Number(match[1]));
  }
  return 1;
}
