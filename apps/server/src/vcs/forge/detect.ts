import { normalizeRemoteUrl } from "@tide/contracts";
import { Git } from "../git.ts";
import type { Forge, RemoteRef } from "./types.ts";

/**
 * `origin` → host/owner/name. Accepts https (with or without credentials or `.git`), scp-like
 * ssh (`git@host:owner/name.git`), `ssh://` with an optional port and `git://`. Nested groups
 * (GitLab) keep everything before the last segment as the owner.
 */
export function parseRemoteUrl(raw: string): RemoteRef | undefined {
  const url = raw.trim();
  if (url.startsWith("/") || url.startsWith("file://")) return undefined;
  const key = normalizeRemoteUrl(url);
  if (key === undefined) return undefined;
  const segments = key.split("/");
  const host = segments.shift() as string;
  const name = segments.pop() as string;
  return { host, owner: segments.join("/"), name };
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
