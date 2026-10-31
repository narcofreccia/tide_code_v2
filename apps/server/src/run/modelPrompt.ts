import { RunProfile } from "@tide/contracts";
import { LOCAL_URL, parseDotenv } from "./detectEnv.ts";
import { joinRel, type RepoFs } from "./fsFacade.ts";

export const MODEL_SYSTEM = `You describe how to run a repository for local development. Return exactly one JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(RunProfile)}`;

const TREE_SKIP = new Set(["node_modules", ".git", "dist", "target", "build", ".venv", "venv", "__pycache__", ".tide", ".next", ".expo"]);
const TREE_MAX = 300;
const TOTAL_MAX = 24 * 1024;
const README_MAX = 1536;

/** Per-manifest byte caps. */
function capFor(rel: string): number {
  const name = rel.split("/").pop() ?? rel;
  if (name === "package.json") return 4096;
  if (/compose\.ya?ml$/.test(name)) return 3072;
  return 2048;
}

const clip = (text: string, max: number): string => (Buffer.byteLength(text) <= max ? text : `${Buffer.from(text).subarray(0, max).toString("utf8")}\n…(truncated)`);

/** `.env.example` with every value that is not a local URL or a port number replaced by `***`. */
export function maskEnv(text: string): string {
  const keep = (v: string): boolean => v === "" || LOCAL_URL.test(v) || /^\d{1,5}$/.test(v);
  return [...parseDotenv(text)].map(([k, v]) => `${k}=${keep(v) ? v : "***"}`).join("\n");
}

/** Depth-2 file tree, at most 300 entries, build/vendor dirs skipped. */
export async function fileTree(fs: RepoFs): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fs.list("")) {
    if (out.length >= TREE_MAX) break;
    if (name.endsWith("/") && TREE_SKIP.has(name.slice(0, -1))) continue;
    out.push(name);
    if (!name.endsWith("/")) continue;
    for (const child of await fs.list(name.slice(0, -1))) {
      if (out.length >= TREE_MAX) break;
      if (child.endsWith("/") && TREE_SKIP.has(child.slice(0, -1))) continue;
      out.push(joinRel(name.slice(0, -1), child));
    }
  }
  return out;
}

/** User prompt for the model: tree + capped manifests + README head, ≤ 24 KB in all. */
export async function buildModelPrompt(fs: RepoFs, repoKey: string, manifests: Record<string, string>): Promise<string> {
  const parts: string[] = [
    `Repository key: ${repoKey}. Use "source": "model", "version": 1, and this repoKey. List the services a developer starts for local development (dev servers, APIs, workers, local infra), with the ports they listen on and the env vars that point at other services. Use "?:<port>" in connects[].to when the target is outside this repo.`,
  ];
  parts.push(`File tree (depth 2):\n${(await fileTree(fs)).join("\n")}`);
  for (const rel of Object.keys(manifests).sort()) {
    const raw = manifests[rel] as string;
    const text = rel.endsWith(".env.example") ? maskEnv(raw) : raw;
    parts.push(`--- ${rel} ---\n${clip(text, capFor(rel))}`);
  }
  for (const name of ["README.md", "readme.md", "README"]) {
    const text = await fs.readText(name, 256 * 1024);
    if (text === undefined) continue;
    parts.push(`--- ${name} (head) ---\n${clip(text, README_MAX)}`);
    break;
  }
  let out = "";
  for (const p of parts) {
    const next = out === "" ? p : `${out}\n\n${p}`;
    if (Buffer.byteLength(next) > TOTAL_MAX) {
      out = clip(next, TOTAL_MAX - 32);
      break;
    }
    out = next;
  }
  return out;
}
