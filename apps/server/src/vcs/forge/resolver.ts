import type { Git } from "../git.ts";
import { detectForge, type DetectedForge } from "./detect.ts";
import type { Forge } from "./types.ts";

const TTL_MS = 10 * 60_000;

export interface ForgeResolverOptions {
  forges: Forge[];
  git?: (cwd: string) => Git;
  now?: () => number;
}

/** Which forge serves a checkout, cached per directory for 10 minutes (a remote rarely moves). */
export class ForgeResolver {
  readonly forges: Forge[];
  #git: ((cwd: string) => Git) | undefined;
  #now: () => number;
  #cache = new Map<string, { value: DetectedForge | undefined; at: number }>();

  constructor(options: ForgeResolverOptions) {
    this.forges = options.forges;
    this.#git = options.git;
    this.#now = options.now ?? (() => Date.now());
  }

  async forDir(dir: string): Promise<DetectedForge | undefined> {
    const at = this.#now();
    const hit = this.#cache.get(dir);
    if (hit !== undefined && at - hit.at < TTL_MS) return hit.value;
    const value = await detectForge(dir, this.forges, this.#git);
    this.#cache.set(dir, { value, at });
    return value;
  }

  /** The primary forge's login state (GitHub's `gh auth status`), for `server.info.tools.ghAuth`. */
  async ghAuth(): Promise<boolean | undefined> {
    const github = this.forges.find((f) => f.kind === "github");
    if (github === undefined) return undefined;
    try {
      return (await github.authStatus()).loggedIn;
    } catch {
      return undefined;
    }
  }
}
