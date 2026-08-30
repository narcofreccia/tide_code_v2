import { execFile } from "node:child_process";

const TIMEOUT_MS = 60_000;

export interface PrRef {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
}

export interface PrCreateInput {
  title: string;
  body?: string;
  base?: string;
  head?: string;
}

/** The slice of the `gh` CLI the publish flow needs; injectable so tests never shell out. */
export interface GhLike {
  hasGh(): Promise<boolean>;
  prCreate(cwd: string, input: PrCreateInput): Promise<{ url: string; number: number }>;
  prView(cwd: string, branch: string): Promise<PrRef | undefined>;
}

export class GhError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(stderr.trim() === "" ? message : `${message}: ${stderr.trim().split("\n")[0] ?? ""}`);
    this.name = "GhError";
    this.stderr = stderr;
  }
}

function run(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { ...(cwd !== undefined ? { cwd } : {}), timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (err === null ? "" : String(err.message)) });
      },
    );
  });
}

function toState(raw: unknown): PrRef["state"] {
  const s = String(raw ?? "").toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/** Best-effort `gh` wrapper: every failure surfaces as a GhError with the CLI's own message. */
export class Gh implements GhLike {
  #available: boolean | undefined;

  async hasGh(): Promise<boolean> {
    if (this.#available !== undefined) return this.#available;
    const r = await run(["--version"]);
    this.#available = r.code === 0;
    return this.#available;
  }

  async prCreate(cwd: string, input: PrCreateInput): Promise<{ url: string; number: number }> {
    const args = ["pr", "create", "--title", input.title, "--body", input.body ?? ""];
    if (input.base !== undefined) args.push("--base", input.base);
    if (input.head !== undefined) args.push("--head", input.head);
    const created = await run(args, cwd);
    if (created.code !== 0) throw new GhError("gh pr create failed", created.stderr);
    const url = created.stdout.trim().split("\n").filter((l) => l.startsWith("http")).pop();
    if (url === undefined) throw new GhError("gh pr create returned no URL", created.stdout);
    const number = Number(url.split("/").pop());
    return { url, number: Number.isFinite(number) ? number : 0 };
  }

  async prView(cwd: string, branch: string): Promise<PrRef | undefined> {
    const r = await run(["pr", "view", branch, "--json", "url,number,state"], cwd);
    if (r.code !== 0) return undefined; // no PR for this branch is the normal case
    try {
      const parsed = JSON.parse(r.stdout) as { url?: string; number?: number; state?: string };
      if (typeof parsed.url !== "string" || typeof parsed.number !== "number") return undefined;
      return { url: parsed.url, number: parsed.number, state: toState(parsed.state) };
    } catch {
      throw new GhError("gh pr view returned unparseable JSON", r.stdout);
    }
  }
}
