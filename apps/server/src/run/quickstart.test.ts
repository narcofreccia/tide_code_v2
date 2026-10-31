import { describe, expect, it } from "vitest";
import type { RunProfile } from "@tide/contracts";
import { parseQuickstart, QUICKSTART_NOTE, writeQuickstart } from "./quickstart.ts";
import { listenKey, parseKey, serviceKey } from "./keys.ts";

const profile: RunProfile = {
  version: 1,
  repoKey: "tide_frontend",
  services: [
    {
      id: "web",
      name: "Vite | dev",
      command: "npm run dev",
      listens: [{ name: "http", port: 8081, how: "flag", flag: "--port", strictFlag: "--strictPort" }],
      connects: [{ env: "VITE_API_URL", to: "tide_backend.api", template: "http://localhost:${port}" }],
      env: {},
      readiness: { kind: "log", pattern: "(Local:|ready in)" },
      kind: "vite",
    },
    {
      id: "server",
      name: "Node server",
      command: "npm run start",
      listens: [{ name: "http", port: 8081, how: "env", envVar: "PORT" }],
      connects: [],
      env: {},
      readiness: { kind: "port", listen: "http" },
      default: false,
    },
  ],
  source: "manifest",
  manifestHash: "abc",
  generatedAt: 1,
  warnings: [],
};
const fence = (body: string): string => "```tide-run\n" + body + "\n```";

describe("parseQuickstart", () => {
  it("no block → nothing", () => {
    expect(parseQuickstart("# Hi\n\n```json\n{}\n```\n")).toEqual({});
  });

  it("the last block wins", () => {
    const other = { ...profile, repoKey: "older" };
    const text = `# Q\n\n${fence(JSON.stringify(other))}\n\nmore\n\n${fence(JSON.stringify(profile))}\n`;
    expect(parseQuickstart(text).profile?.repoKey).toBe("tide_frontend");
  });

  it("bad JSON reports the file line", () => {
    const text = `# Q\n\nintro\n\n\`\`\`tide-run\n{\n  "version": 1,\n  "repoKey": "x"\n  "services": []\n}\n\`\`\`\n`;
    const r = parseQuickstart(text);
    expect(r.profile).toBeUndefined();
    expect(r.error?.message).toMatch(/invalid JSON/);
    // the block body starts on line 6; the missing comma is detected on line 9
    expect(r.error?.line).toBe(9);
  });

  it("schema errors name the path", () => {
    const r = parseQuickstart(fence(JSON.stringify({ ...profile, repoKey: "Bad Key" })));
    expect(r.error?.message).toMatch(/\/repoKey/);
    expect(r.error?.line).toBe(2);
  });
});

describe("writeQuickstart", () => {
  it("creates a section from nothing and round-trips", () => {
    const out = writeQuickstart(undefined, profile);
    expect(out.startsWith("## Run with Tide\n\n" + QUICKSTART_NOTE)).toBe(true);
    expect(out).toContain("| Vite \\| dev | `npm run dev` | http :8081 (--port) | VITE_API_URL → tide_backend.api |");
    expect(out).toContain("| Node server · off by default | `npm run start` | http :8081 (PORT) | — |");
    expect(parseQuickstart(out).profile).toEqual(profile);
  });

  it("appends to existing prose untouched", () => {
    const prose = "# Quickstart\n\nRun `make deps` first.\n";
    const out = writeQuickstart(prose, profile);
    expect(out.startsWith("# Quickstart\n\nRun `make deps` first.\n\n## Run with Tide")).toBe(true);
  });

  it("replaces block and table in place; prose outside them is byte-identical", () => {
    const first = writeQuickstart("# Q\n\nBefore.\n", profile);
    const edited = first.replace("## Run with Tide\n\n", "## Run with Tide\n\nHand-written prerequisites.\n\n") + "\nTroubleshooting: restart redis.\n";
    const next = { ...profile, services: [profile.services[0] as RunProfile["services"][number]], generatedAt: 2 };
    const out = writeQuickstart(edited, next);
    expect(parseQuickstart(out).profile).toEqual(next);
    expect(out).not.toContain("Node server");
    const strip = (t: string) => t.replace(/<!-- tide-run:table -->[\s\S]*?<!-- \/tide-run:table -->/, "T").replace(/```tide-run[\s\S]*?```/, "B");
    expect(strip(out)).toBe(strip(edited));
    expect(out).toContain("Hand-written prerequisites.");
    expect(out.endsWith("\nTroubleshooting: restart redis.\n")).toBe(true);
  });

  it("a hand-written block without markers gets the table above it", () => {
    const text = `# Q\n\n${fence(JSON.stringify(profile))}\n\nafter\n`;
    const out = writeQuickstart(text, profile);
    expect(out.startsWith("# Q\n\n<!-- tide-run:table -->")).toBe(true);
    expect(out.endsWith("```\n\nafter\n")).toBe(true);
    expect(writeQuickstart(out, profile)).toBe(out);
  });
});

describe("keys", () => {
  it("build and parse", () => {
    expect(serviceKey("tide_backend", "api")).toBe("tide_backend.api");
    expect(listenKey("tide_pos2", "app", "sync")).toBe("tide_pos2.app.sync");
    expect(parseKey("tide_pos2.app.sync")).toEqual({ repoKey: "tide_pos2", serviceId: "app", listen: "sync" });
    expect(parseKey("tide_backend.api")).toEqual({ repoKey: "tide_backend", serviceId: "api" });
    expect(parseKey("nope")).toBeUndefined();
  });
});
