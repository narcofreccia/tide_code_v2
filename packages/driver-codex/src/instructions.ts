/**
 * Codex-specific instruction delivery via `turn/start.additionalContext` and post-compaction
 * restoration via `thread/inject_items`.
 *
 * Why `additionalContext` instead of `developerInstructions` / `collaborationMode`:
 * 1. Newer Codex models ship catalog collaboration-mode instructions that override client
 *    `developer_instructions`.
 * 2. Codex silently middle-truncates any `additionalContext` entry over 1,000 tokens
 *    (counted as UTF-8 bytes / 4 = 4,000 bytes), so we split Tide's instructions into
 *    numbered entries strictly below that limit (Codex emits keys in sorted order).
 * 3. Context compaction drops client developer messages while Codex only resends
 *    `additionalContext` when its value changes; `toInjectItems` restores them after
 *    `turn/completed`.
 */

export const CODEX_ADDITIONAL_CONTEXT_MAX_BYTES = 4_000;
const CHUNK_TARGET_BYTES = 3_800;

export interface AdditionalContextEntry {
  kind: "application";
  value: string;
}

export type AdditionalContextMap = Record<string, AdditionalContextEntry>;

export interface CodexRuntimeInfo {
  model?: string | undefined;
  effort?: string | undefined;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Slices a single oversized line on UTF-8 code-point boundaries so no chunk exceeds `maxBytes`. */
function sliceUtf8(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const chBytes = utf8Bytes(ch);
    if (curBytes + chBytes > maxBytes && cur !== "") {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** Splits text into self-contained sections each strictly within `maxBytes` UTF-8 bytes. */
export function splitForCodexContext(text: string, maxBytes = CHUNK_TARGET_BYTES): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (utf8Bytes(trimmed) <= maxBytes) return [trimmed];

  const units: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (p === "") continue;
    if (utf8Bytes(p) <= maxBytes) {
      units.push(p);
      continue;
    }
    for (const line of p.split("\n")) {
      const l = line.trim();
      if (l === "") continue;
      if (utf8Bytes(l) <= maxBytes) units.push(l);
      else units.push(...sliceUtf8(l, maxBytes));
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current === "" ? unit : `${current}\n\n${unit}`;
    if (utf8Bytes(candidate) <= maxBytes) {
      current = candidate;
    } else {
      if (current !== "") chunks.push(current);
      current = unit;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function buildRuntimeInfo(runtime: CodexRuntimeInfo): string {
  const model = runtime.model?.trim() ?? "";
  const effort = runtime.effort?.trim() ?? "";
  const modelPart = model !== "" && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortPart = effort !== "" ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>You are running in Tide through the Codex harness${modelPart}${effortPart}. No need to mention this unless asked.</runtime_info>`;
}

export function buildCodexAdditionalContext(
  systemPromptAppend: string | undefined,
  runtime?: CodexRuntimeInfo,
): AdditionalContextMap | undefined {
  const sections = systemPromptAppend ? splitForCodexContext(systemPromptAppend) : [];
  const entries: [string, AdditionalContextEntry][] = sections.map((value, i) => [
    `tide_instructions_${String(i + 1).padStart(2, "0")}`,
    { kind: "application", value },
  ]);
  if (runtime !== undefined && (sections.length > 0 || (runtime.model ?? "") !== "" || (runtime.effort ?? "") !== "")) {
    entries.push(["tide_runtime", { kind: "application", value: buildRuntimeInfo(runtime) }]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Converts `additionalContext` entries into Responses API developer items for `thread/inject_items`. */
export function toInjectItems(context: AdditionalContextMap): Array<{
  type: "message";
  role: "developer";
  content: Array<{ type: "input_text"; text: string }>;
}> {
  return Object.entries(context).map(([key, entry]) => ({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
  }));
}
