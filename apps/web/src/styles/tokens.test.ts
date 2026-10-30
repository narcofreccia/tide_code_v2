// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * Type sizes come from the `--fs-*` scale in tokens.css; a raw `font-size: 12px`
 * anywhere else drifts from it. The stylesheets are read from disk: Vitest's CSS
 * handling blanks them out when imported, and the web app carries no node types,
 * so `node:fs` is loaded through a narrow local interface.
 */
interface Dirent {
  name: string;
  isDirectory(): boolean;
}
interface Fs {
  readdirSync(dir: URL, options: { withFileTypes: true }): Dirent[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const NODE_FS = "node:fs";
const fs = (await import(/* @vite-ignore */ NODE_FS)) as Fs;

const SRC = new URL("../", import.meta.url);
const LITERAL = /font-size\s*:\s*-?[0-9.]+px/;

/** every `*.module.css` under src, plus `styles/*.css` except tokens.css */
function stylesheets(dir: URL, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${rel}${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, stylesheets(new URL(`${entry.name}/`, dir), `${path}/`));
    } else if (path.endsWith(".module.css") || (rel === "styles/" && path.endsWith(".css") && path !== "styles/tokens.css")) {
      out[path] = fs.readFileSync(new URL(entry.name, dir), "utf8");
    }
  }
  return out;
}

function offenders(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    source.split("\n").forEach((line, i) => {
      if (LITERAL.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("type tokens", () => {
  const files = stylesheets(SRC);

  it("finds the stylesheets it is meant to police", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(Object.keys(files)).toContain("styles/global.css");
    expect(Object.keys(files)).not.toContain("styles/tokens.css");
  });

  it("has no px font-size literals outside tokens.css", () => {
    expect(offenders(files)).toEqual([]);
  });

  it("flags a literal and lets tokens and relative units through", () => {
    const sample = {
      "x.module.css":
        "a { font-size: 12px; }\nb { font-size: var(--fs-sm); }\nc { font-size: 0.9em; }\nd { font-size: 90%; }\ne { font-size: inherit; }",
    };
    expect(offenders(sample)).toEqual(["x.module.css:1: a { font-size: 12px; }"]);
  });
});
