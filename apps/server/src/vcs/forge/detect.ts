import { Git } from "../git.ts";
import type { Forge, RemoteRef } from "./types.ts";

/**
 * `origin` → host/owner/name. Accepts https (with or without credentials or `.git`), scp-like
 * ssh (`git@host:owner/name.git`), `ssh://` with an optional port and `git://`. Nested groups
 * (GitLab) keep everything before the last segment as the owner.
 */
export function parseRemoteUrl(raw: string): RemoteRef | undefined {
  const url = raw.trim();
  if (url === "") return undefined;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp !== null && scp[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    path = scp[2];
  } else return undefined;
  const segments = path.replace(/\.git\/?$/, "").replace(/\/+$/, "").split("/").filter((s) => s !== "");
  if (segments.length < 2 || host === "") return undefined;
  const name = segments.pop() as string;
  return { host: host.toLowerCase(), owner: segments.join("/"), name };
}

export interface DetectedForge {
  forge: Forge;
  remote: RemoteRef;
  /** `owner/name` */
  repo: string;
}

/** The forge serving `repoDir`'s `origin`, or undefined (no repo, no origin, or an unknown host). */
export async function detectForge(repoDir: string, forges: Forge[], git: (cwd: string) => Git = (cwd) => new Git(cwd)): Promise<DetectedForge | undefined> {
  const r = await git(repoDir).tryRun(["remote", "get-url", "origin"]);
  if (r.code !== 0) return undefined;
  const url = r.stdout.trim();
  const remote = parseRemoteUrl(url);
  if (remote === undefined) return undefined;
  for (const forge of forges) {
    // auth status teaches the forge which enterprise hosts the user configured
    if (!forge.detect(url)) await forge.authStatus().catch(() => undefined);
    if (forge.detect(url)) return { forge, remote, repo: `${remote.owner}/${remote.name}` };
  }
  return undefined;
}
