/**
 * Absolute paths as the server sends them. The client may talk to several machines with
 * different OSes at once and never knows which one a path came from, so every helper here
 * reads the path's own shape:
 *
 * - POSIX: `/home/me/repo`
 * - Windows drive: `C:\Users\me\repo` or `C:/Users/me/repo`
 * - Windows UNC: `\\server\share\dir`
 *
 * A path that is not rooted but contains a backslash (`src\lib\a.ts`) is read as Windows
 * too: a POSIX name with a backslash in it is rare, harness output from Windows is not.
 * Windows-shaped paths accept both separators and compare case-insensitively.
 */

const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const UNC = /^[\\/]{2}([^\\/]+)(?:[\\/]+([^\\/]+))?[\\/]*/;

type Sep = "/" | "\\";

interface Parsed {
  windows: boolean;
  sep: Sep;
  /** the root as written back: `/`, `C:\`, `\\server\share\`, or `` for a relative path */
  root: string;
  /** the UNC share name, so `\\server\share` still has a basename */
  share?: string;
  segments: string[];
}

function isWindowsShaped(path: string): boolean {
  if (path.startsWith("\\") || DRIVE.test(path)) return true;
  return !path.startsWith("/") && path.includes("\\");
}

function parse(path: string): Parsed {
  if (!isWindowsShaped(path)) {
    const root = path.startsWith("/") ? "/" : "";
    return { windows: false, sep: "/", root, segments: path.split("/").filter(Boolean) };
  }
  const sep: Sep = path.includes("\\") ? "\\" : "/";
  let root = "";
  let rest = path;
  let share: string | undefined;
  const drive = DRIVE.exec(path);
  const unc = drive ? null : /^[\\/]{2}/.test(path) ? UNC.exec(path) : null;
  if (drive) {
    root = `${path.slice(0, 2)}${sep}`;
    rest = path.slice(drive[0].length);
  } else if (unc) {
    share = unc[2];
    root = `${sep}${sep}${unc[1]}${share === undefined ? "" : `${sep}${share}`}${sep}`;
    rest = path.slice(unc[0].length);
  } else if (path.startsWith("\\")) {
    // `\dir`: rooted on the current drive
    root = sep;
    rest = path.slice(1);
  }
  return { windows: true, sep, root, ...(share === undefined ? {} : { share }), segments: rest.split(/[\\/]/).filter(Boolean) };
}

function format(parsed: Parsed, segments: string[]): string {
  return `${parsed.root}${segments.join(parsed.sep)}`;
}

/** POSIX `/…`, drive `C:\…` / `C:/…`, or UNC `\\server\share…`. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** The last segment; `""` for a root (`/`, `C:\`). A UNC share root names the share. */
export function basename(path: string): string {
  const parsed = parse(path);
  return parsed.segments.at(-1) ?? parsed.share ?? "";
}

/** The parent directory, or undefined for a root or a bare name. */
export function dirname(path: string): string | undefined {
  const parsed = parse(path);
  if (parsed.segments.length === 0) return undefined;
  const parent = format(parsed, parsed.segments.slice(0, -1));
  return parent === "" ? undefined : parent;
}

/** `name` (which may hold `/`-separated segments) under `dir`, with the separator `dir` uses. */
export function joinPath(dir: string, name: string): string {
  if (dir === "") return name;
  const parsed = parse(dir);
  const extra = name.split(parsed.windows ? /[\\/]/ : "/").filter(Boolean);
  return format(parsed, [...parsed.segments, ...extra]);
}

/** The separator a path already uses. */
export function separatorOf(path: string): Sep {
  return parse(path).sep;
}

function key(parsed: Parsed): string[] {
  const parts = [parsed.root.replace(/[\\/]/g, "/"), ...parsed.segments];
  return parsed.windows ? parts.map((p) => p.toLowerCase()) : parts;
}

/** Same folder, ignoring trailing separators (and, for Windows paths, case and separator kind). */
export function samePath(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.windows !== pb.windows) return false;
  const ka = key(pa);
  const kb = key(pb);
  return ka.length === kb.length && ka.every((part, i) => part === kb[i]);
}

/**
 * `path` relative to `root` with `/` separators (the form repo-relative paths take on the
 * wire), or undefined when it is not strictly inside `root`.
 */
export function relativeTo(path: string, root: string): string | undefined {
  if (root === "" || !isAbsolutePath(path)) return undefined;
  const pp = parse(path);
  const pr = parse(root);
  if (pp.windows !== pr.windows) return undefined;
  const kp = key(pp);
  const kr = key(pr);
  if (kp.length <= kr.length || !kr.every((part, i) => part === kp[i])) return undefined;
  return pp.segments.slice(pr.segments.length).join("/");
}

/** `…/src/components/foo.ts`: the last `count` segments of a long path, for display. */
export function pathTail(path: string, count: number): string {
  const parsed = parse(path);
  if (parsed.segments.length <= count) return path;
  return `…${parsed.sep}${parsed.segments.slice(-count).join(parsed.sep)}`;
}

/** Splits at the last separator: `{ dir: "/a/b/", base: "c" }`; `dir` keeps its trailing separator. */
export function splitLast(path: string): { dir: string; base: string } {
  const at = isWindowsShaped(path) ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/");
  return at === -1 ? { dir: "", base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

/** `C:\Users\me` → `C:`, `Users`, `me`, each with the path it opens. */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  const parsed = parse(path);
  const crumbs: { label: string; path: string }[] = [];
  if (parsed.root !== "") {
    const label = parsed.root === "/" || parsed.root === "\\" ? parsed.root : parsed.root.replace(/[\\/]+$/, "");
    crumbs.push({ label, path: parsed.root });
  }
  parsed.segments.forEach((segment, i) => {
    crumbs.push({ label: segment, path: format(parsed, parsed.segments.slice(0, i + 1)) });
  });
  return crumbs;
}
