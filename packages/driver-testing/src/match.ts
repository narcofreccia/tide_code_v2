/**
 * Subset matching for `expect_out`.
 *  - objects: every key in `expected` must match the same key in `actual` (extra keys allowed)
 *  - arrays: same length, element-wise
 *  - strings: `/re/flags` is a regex, `"$any"` matches any value, anything else is exact
 *  - top-level string: a pattern over the serialised frame (regex if slashed, else substring)
 */

export interface MatchResult {
  ok: boolean;
  mismatches: string[];
}

const REGEX = /^\/(.*)\/([dgimsuvy]*)$/s;

export function toRegExp(pattern: string): RegExp | undefined {
  const parts = REGEX.exec(pattern);
  if (!parts) return undefined;
  return new RegExp(parts[1]!, parts[2]!.replace(/[gy]/g, ""));
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function walk(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (expected === "$any") {
    if (actual === undefined) out.push(`${path}: expected a value, got nothing`);
    return;
  }
  if (typeof expected === "string") {
    const regex = toRegExp(expected);
    if (typeof actual !== "string") out.push(`${path}: expected ${show(expected)}, got ${show(actual)}`);
    else if (regex ? !regex.test(actual) : actual !== expected) out.push(`${path}: expected ${regex ? `match ${expected}` : show(expected)}, got ${show(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${show(actual)}`);
      return;
    }
    if (actual.length !== expected.length) out.push(`${path}: expected ${expected.length} element(s), got ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) walk(expected[i], actual[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      out.push(`${path}: expected an object, got ${show(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      const child = (actual as Record<string, unknown>)[key];
      if (child === undefined && value !== undefined) out.push(`${path}.${key}: missing (expected ${show(value)})`);
      else walk(value, child, `${path}.${key}`, out);
    }
    return;
  }
  if (expected !== actual) out.push(`${path}: expected ${show(expected)}, got ${show(actual)}`);
}

export function matchFrame(expected: unknown, actual: unknown): MatchResult {
  if (typeof expected === "string" && expected !== "$any") {
    const text = typeof actual === "string" ? actual : JSON.stringify(actual);
    const regex = toRegExp(expected);
    const ok = regex ? regex.test(text) : text.includes(expected);
    return { ok, mismatches: ok ? [] : [`$: expected the frame to ${regex ? `match ${expected}` : `contain ${show(expected)}`}, got ${show(actual)}`] };
  }
  const mismatches: string[] = [];
  walk(expected, actual, "$", mismatches);
  return { ok: mismatches.length === 0, mismatches };
}

/** Replaces every string equal to `"$id"` (deeply) with `id`. */
export function substituteId(value: unknown, id: unknown): unknown {
  if (value === "$id") return id;
  if (Array.isArray(value)) return value.map((item) => substituteId(item, id));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteId(item, id)]));
  return value;
}
