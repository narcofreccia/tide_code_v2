import { Check, Errors } from "typebox/value";
import { RunProfile, type RunListen, type RunService } from "@tide/contracts";

const BLOCK = /^```tide-run[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
const TABLE_OPEN = "<!-- tide-run:table -->";
const TABLE_CLOSE = "<!-- /tide-run:table -->";
const TABLE = /<!-- tide-run:table -->[\s\S]*?<!-- \/tide-run:table -->/;

export const QUICKSTART_NOTE =
  "Tide reads the `tide-run` block below to start this repo together with its linked repos (Run panel). " +
  "Edit the JSON to change commands, ports or env; Tide regenerates the table when it rewrites this section and leaves the prose around it alone.";

interface Block {
  start: number;
  end: number;
  body: string;
  bodyStart: number;
}

function lastBlock(text: string): Block | undefined {
  let last: Block | undefined;
  for (const m of text.matchAll(BLOCK)) {
    const body = m[1] as string;
    last = { start: m.index, end: m.index + m[0].length, body, bodyStart: m.index + m[0].indexOf("\n") + 1 };
  }
  return last;
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/** Line (1-based, within `body`) a JSON.parse error points at; V8 reports "line N" or "position N". */
function jsonErrorLine(body: string, message: string): number {
  const line = /line (\d+)/.exec(message);
  if (line) return Number(line[1]);
  const pos = /position (\d+)/.exec(message);
  if (pos) return lineAt(body, Number(pos[1]));
  return 1;
}

/** The last ```tide-run``` block of a QUICKSTART.md, validated. `{}` when there is none. */
export function parseQuickstart(text: string): { profile?: RunProfile; error?: { message: string; line: number } } {
  const block = lastBlock(text);
  if (block === undefined) return {};
  const firstLine = lineAt(text, block.bodyStart);
  let value: unknown;
  try {
    value = JSON.parse(block.body);
  } catch (err) {
    const message = (err as Error).message;
    return { error: { message: `invalid JSON in tide-run block: ${message}`, line: firstLine + jsonErrorLine(block.body, message) - 1 } };
  }
  if (!Check(RunProfile, value)) {
    const first = Errors(RunProfile, value)[0];
    const where = first?.instancePath ? `${first.instancePath}: ` : "";
    return { error: { message: `tide-run block is not a valid run profile: ${where}${first?.message ?? "invalid"}`, line: firstLine } };
  }
  return { profile: value };
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function listenCell(l: RunListen): string {
  const how = l.how === "fixed" ? "fixed" : l.how === "env" ? (l.envVar ?? "env") : (l.flag ?? "flag");
  return `${l.name} :${l.port} (${how})`;
}

function row(s: RunService): string {
  const listens = s.listens.map(listenCell).join(", ") || "—";
  const connects = s.connects.map((c) => `${c.env} → ${c.to}`).join(", ") || "—";
  const name = s.cwd !== undefined && s.cwd !== "." ? `${s.name} (${s.cwd})` : s.name;
  const off = s.default === false ? " · off by default" : "";
  return `| ${cell(name + off)} | \`${cell(s.command)}\` | ${cell(listens)} | ${cell(connects)} |`;
}

export function quickstartTable(profile: RunProfile): string {
  const rows = profile.services.length > 0 ? profile.services.map(row) : ["| — | — | — | — |"];
  return [TABLE_OPEN, "| Service | Command | Listens | Talks to |", "| --- | --- | --- | --- |", ...rows, TABLE_CLOSE].join("\n");
}

export const quickstartBlock = (profile: RunProfile): string => `\`\`\`tide-run\n${JSON.stringify(profile, null, 2)}\n\`\`\``;

/**
 * Writes the profile into a QUICKSTART.md: replaces the last tide-run block (and the marked table)
 * in place; with no block, appends a "## Run with Tide" section. Bytes outside the block and the
 * table markers are never changed.
 */
export function writeQuickstart(existing: string | undefined, profile: RunProfile): string {
  const table = quickstartTable(profile);
  const block = quickstartBlock(profile);
  const text = existing ?? "";
  const found = lastBlock(text);
  if (found === undefined) {
    const section = `## Run with Tide\n\n${QUICKSTART_NOTE}\n\n${table}\n\n${block}\n`;
    if (text.trim() === "") return section;
    return `${text.replace(/\s*$/, "")}\n\n${section}`;
  }
  const replaced = text.slice(0, found.start) + block + text.slice(found.end);
  if (TABLE.test(replaced)) return replaced.replace(TABLE, () => table);
  // block without markers (hand-written): put the table right above it
  return `${replaced.slice(0, found.start)}${table}\n\n${replaced.slice(found.start)}`;
}
