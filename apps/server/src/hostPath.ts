import { posix, win32 } from "node:path";

/**
 * Host-path rules that differ on Windows, as pure functions of `platform` so a test on any host
 * can exercise both. POSIX results are what the callers did before these helpers existed.
 */

/** `~`, `~/x` (and `~\x` on Windows) are this machine's home; anything else is returned as is. */
export function expandHome(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (path === "~") return home;
  const windows = platform === "win32";
  if (path.startsWith("~/") || (windows && path.startsWith("~\\"))) return (windows ? win32 : posix).join(home, path.slice(2));
  return path;
}

/**
 * One spelling per folder for a project root on Windows: `c:/Users/me/repo/` and `C:\Users\me\repo`
 * are the same folder, and the duplicate check in the decider compares strings. Separators, a
 * trailing separator, `.`/`..` segments and the drive letter's case are normalised; other segments
 * keep their case (that would need the filesystem). POSIX paths and relative paths are
 * returned unchanged.
 */
export function normalizeRootPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || !win32.isAbsolute(path)) return path;
  return win32.resolve(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Why `name` cannot be a folder on this platform, or undefined. Windows refuses device names
 * (`con`, `nul.txt`, …) and silently drops a trailing dot, so `app.` would be created as `app`
 * while Tide recorded `app.`.
 */
export function windowsFolderNameProblem(name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  if (WINDOWS_RESERVED.test(name.split(".")[0] ?? "")) return `${name} is a reserved device name on Windows`;
  if (/[. ]$/.test(name)) return `${name} ends with a dot or a space, which Windows drops`;
  return undefined;
}
