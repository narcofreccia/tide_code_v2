/**
 * R17: one repository across machines. A project on machine A and a clone of the same repo on
 * machine B share a key derived from their `origin` URL, so the client can show them as one.
 * Pure string work; the server detects the URL, every client applies the same normalisation.
 */

/**
 * `origin` URL → `host/owner/name`, lowercase host, no scheme, credentials, port, `.git` or
 * trailing slash. Accepts https, `ssh://` (with a port), `git://`, scp-like `git@host:owner/name`
 * and nested groups (GitLab keeps every segment before the last as the owner). Local paths
 * (`/srv/origin.git`, `file:///…`) normalise to `local/<path without .git>` so two clones of a
 * bare repo on the same disk still group. Returns `undefined` for anything else.
 */
export function normalizeRemoteUrl(raw: string): string | undefined {
  const url = raw.trim();
  if (url === "") return undefined;
  if (url.startsWith("/") || url.startsWith("file://")) {
    const path = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
    const clean = stripRepoSuffix(path);
    return clean === "" ? undefined : `local${clean.startsWith("/") ? "" : "/"}${clean}`;
  }
  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/\s?#]+)(?::\d+)?(\/[^?#\s]*)?/i.exec(url);
  if (scheme !== null) {
    host = scheme[1] ?? "";
    path = scheme[2] ?? "";
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
    if (scp === null || scp[1] === undefined || scp[2] === undefined) return undefined;
    host = scp[1];
    path = scp[2];
  }
  const segments = stripRepoSuffix(path).split("/").filter((s) => s !== "");
  if (host === "" || segments.length < 2) return undefined;
  return `${host.toLowerCase()}/${segments.join("/")}`;
}

/** `host/owner/name` → `owner/name` (the part people recognise); a local key keeps its last two segments. */
export function repoDisplayName(remoteUrl: string): string {
  const segments = remoteUrl.split("/").filter((s) => s !== "");
  return segments.slice(-2).join("/");
}

function stripRepoSuffix(path: string): string {
  return path.replace(/\.git\/?$/, "").replace(/\/+$/, "");
}
