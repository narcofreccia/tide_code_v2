import { execFile, spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SearchMatch } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";
import { IgnoreCache, type GitFactory } from "./ignore.ts";
import { isBinaryBuffer } from "./files.ts";

export const DEFAULT_LIMIT = 500;
/** Matched line text is cut to this many characters before it goes on the wire. */
export const MAX_TEXT = 300;
/** The node fallback never reads a file bigger than this. */
export const MAX_FALLBACK_BYTES = 1024 * 1024;

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
  limit?: number;
  /** force a backend; default is ripgrep when it is on PATH */
  useRipgrep?: boolean;
  git?: GitFactory;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

let ripgrepProbe: Promise<boolean> | undefined;

/** Cached `rg --version` probe. */
export function hasRipgrep(): Promise<boolean> {
  ripgrepProbe ??= new Promise<boolean>((resolve) => {
    execFile("rg", ["--version"], { timeout: 5_000 }, (err) => resolve(err === null));
  });
  return ripgrepProbe;
}

/** Test seam: clears the memoized probe. */
export function resetRipgrepProbe(): void {
  ripgrepProbe = undefined;
}

const clip = (text: string): string => {
  const line = text.replace(/\r?\n$/, "");
  return line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) : line;
};

/** `--smart-case`: insensitive unless the pattern itself carries an uppercase letter. */
export function isCaseSensitive(query: string, caseSensitive: boolean | undefined): boolean {
  if (caseSensitive === true) return true;
  return /[A-Z]/.test(query);
}

export async function search(cwd: string, options: SearchOptions): Promise<SearchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10_000));
  if (options.regex === true) {
    try {
      new RegExp(options.query);
    } catch (err) {
      throw new RpcException("invalid-params", `invalid regular expression: ${(err as Error).message}`);
    }
  }
  const useRg = options.useRipgrep ?? (await hasRipgrep());
  return useRg ? searchWithRipgrep(cwd, options, limit) : searchWithNode(cwd, options, limit);
}

// ---- ripgrep ----

interface RgMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start?: number }[];
  };
}

function ripgrepArgs(options: SearchOptions, limit: number): string[] {
  const args = ["--json", "--max-count", String(limit)];
  if (options.glob !== undefined && options.glob !== "") args.push("--glob", options.glob);
  if (options.regex !== true) args.push("--fixed-strings");
  args.push(options.caseSensitive === true ? "--case-sensitive" : "--smart-case");
  args.push("-e", options.query, ".");
  return args;
}

function searchWithRipgrep(cwd: string, options: SearchOptions, limit: number): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", ripgrepArgs(options, limit), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let buffer = "";
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({ matches, truncated });
    };

    const consume = (line: string): void => {
      if (line === "" || matches.length >= limit) return;
      let parsed: RgMatch;
      try {
        parsed = JSON.parse(line) as RgMatch;
      } catch {
        return;
      }
      if (parsed.type !== "match") return;
      const data = parsed.data;
      const path = data?.path?.text;
      const text = data?.lines?.text;
      const lineNumber = data?.line_number;
      if (path === undefined || text === undefined || lineNumber === undefined) return; // binary hit
      const start = data?.submatches?.[0]?.start ?? 0;
      const column = Buffer.from(text, "utf8").subarray(0, start).toString("utf8").length + 1;
      matches.push({ path: path.replace(/^\.[\\/]/, ""), line: lineNumber, column, text: clip(text) });
      if (matches.length >= limit) {
        truncated = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.resume();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new RpcException("internal", `ripgrep failed: ${err.message}`));
    });
    child.on("close", () => {
      consume(buffer);
      finish();
    });
  });
}

// ---- pure-node fallback ----

/** Minimal glob → RegExp: `**`, `*`, `?`. Patterns without a slash also match a basename. */
export function globToRegExp(glob: string): { re: RegExp; basenameToo: boolean } {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(`^${out}$`), basenameToo: !glob.includes("/") };
}

async function searchWithNode(cwd: string, options: SearchOptions, limit: number): Promise<SearchResult> {
  const matches: SearchMatch[] = [];
  const sensitive = isCaseSensitive(options.query, options.caseSensitive);
  const needle = sensitive ? options.query : options.query.toLowerCase();
  const pattern = options.regex === true ? new RegExp(options.query, sensitive ? "g" : "gi") : undefined;
  const globber = options.glob !== undefined && options.glob !== "" ? globToRegExp(options.glob) : undefined;
  const ignores = new IgnoreCache(cwd, options.git);
  let truncated = false;

  const matchesGlob = (rel: string): boolean => {
    if (globber === undefined) return true;
    if (globber.re.test(rel)) return true;
    return globber.basenameToo && globber.re.test(rel.slice(rel.lastIndexOf("/") + 1));
  };

  const scanFile = async (abs: string, rel: string): Promise<void> => {
    const buf = await readFile(abs).catch(() => undefined);
    if (buf === undefined || isBinaryBuffer(buf)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      if (pattern !== undefined) {
        pattern.lastIndex = 0;
        const hit = pattern.exec(raw);
        if (hit === null) continue;
        matches.push({ path: rel, line: i + 1, column: hit.index + 1, text: clip(raw) });
      } else {
        const hay = sensitive ? raw : raw.toLowerCase();
        const index = hay.indexOf(needle);
        if (index === -1) continue;
        matches.push({ path: rel, line: i + 1, column: index + 1, text: clip(raw) });
      }
      if (matches.length >= limit) {
        truncated = true;
        return;
      }
    }
  };

  const walk = async (dir: string, rel: string): Promise<void> => {
    if (truncated) return;
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) return;
    const children = dirents
      .filter((d) => d.name !== ".git" && !d.isSymbolicLink())
      .map((d) => ({ d, rel: rel === "" ? d.name : `${rel}/${d.name}` }))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const ignored = await ignores.resolve(children.map((c) => c.rel));
    for (const child of children) {
      if (truncated) return;
      if (ignored.get(child.rel) === true) continue;
      const full = join(dir, child.d.name);
      if (child.d.isDirectory()) {
        await walk(full, child.rel);
        continue;
      }
      if (!matchesGlob(child.rel)) continue;
      const st = await stat(full).catch(() => undefined);
      if (st === undefined || st.size > MAX_FALLBACK_BYTES) continue;
      await scanFile(full, child.rel);
    }
  };

  await walk(cwd, "");
  return { matches, truncated };
}
