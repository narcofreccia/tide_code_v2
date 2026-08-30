// NOTE: byte-for-byte copy of packages/driver-claude/src/diff.ts. Approval previews need it in
// both drivers; it moves to a shared package the moment a third driver wants it.
/** Minimal LCS line diff → unified diff. Used only for approval previews, never for VCS. */

const MAX_LINES = 4000;
const CONTEXT = 3;

interface Op {
  kind: "eq" | "del" | "add";
  line: string;
}

function lcsOps(a: string[], b: string[]): Op[] {
  // O(n*m) table; inputs are capped by the caller so this stays a preview-sized cost.
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", line: a[i]! });
  for (; j < m; j++) ops.push({ kind: "add", line: b[j]! });
  return ops;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Unified diff of `before` → `after`. Returns undefined when the two are identical or
 * either side is too large to diff cheaply.
 */
export function unifiedDiff(path: string, before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return undefined;
  const ops = lcsOps(a, b);

  const hunks: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === "eq") {
      oldLine++;
      newLine++;
      index++;
      continue;
    }
    // walk back over up to CONTEXT equal lines, then forward to the end of the change run
    let start = index;
    let leading = 0;
    while (start > 0 && ops[start - 1]!.kind === "eq" && leading < CONTEXT) {
      start--;
      leading++;
    }
    let end = index;
    let trailingEq = 0;
    while (end < ops.length && (ops[end]!.kind !== "eq" || trailingEq < CONTEXT)) {
      trailingEq = ops[end]!.kind === "eq" ? trailingEq + 1 : 0;
      end++;
    }
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k < end; k++) {
      const op = ops[k]!;
      if (op.kind === "eq") {
        body.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.kind === "del") {
        body.push(`-${op.line}`);
        oldCount++;
      } else {
        body.push(`+${op.line}`);
        newCount++;
      }
    }
    hunks.push(`@@ -${oldLine - leading},${oldCount} +${newLine - leading},${newCount} @@\n${body.join("\n")}`);
    for (let k = index; k < end; k++) {
      const op = ops[k]!;
      if (op.kind !== "add") oldLine++;
      if (op.kind !== "del") newLine++;
    }
    index = end;
  }
  if (hunks.length === 0) return undefined;
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}
