import { execFile } from "node:child_process";
import { RpcException } from "./router.ts";

/** `execFile` shape, injected in tests; never a shell string. */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface OpenExternalOptions {
  exec?: ExecFileFn;
  platform?: NodeJS.Platform;
}

export type OpenExternalFn = (url: string) => Promise<{ ok: boolean; error?: string }>;

const SCHEMES = new Set(["vscode", "cursor", "http", "https"]);
const APP_NAMES: Record<string, string> = { vscode: "VS Code", cursor: "Cursor" };

const defaultExec: ExecFileFn = (file, args, options, callback) => {
  execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
};

/** The OS opener for a URL: `open` (macOS), `xdg-open` (linux), `cmd /c start` (windows). */
export function openerCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** The scheme, or an `invalid-params` refusal for anything the desktop should not launch. */
export function checkedScheme(url: string): string {
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    throw new RpcException("invalid-params", "not a URL");
  }
  if (!SCHEMES.has(scheme)) throw new RpcException("invalid-params", `scheme ${scheme}: is not allowed`);
  return scheme;
}

/** macOS says `-10814` (kLSApplicationNotFoundErr) when no app registered the scheme. */
function failureText(scheme: string, error: Error, stderr: string): string {
  const raw = (stderr.trim() || error.message).trim();
  const app = APP_NAMES[scheme];
  if (app !== undefined && /-10814|no application|no handler|not found/i.test(raw)) {
    return `${app} is not installed (${scheme}:// has no handler)`;
  }
  return raw;
}

/**
 * Hands an editor deep link (or a web URL) to the OS. The desktop WebView refuses custom-scheme
 * navigations silently, so the client asks the local server to launch it instead.
 */
export function createOpenExternal(options: OpenExternalOptions = {}): OpenExternalFn {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  return (url) => {
    const scheme = checkedScheme(url);
    const [file, args] = openerCommand(platform, url);
    return new Promise((resolve) => {
      exec(file, args, { timeout: 5000 }, (error, _stdout, stderr) => {
        resolve(error === null ? { ok: true } : { ok: false, error: failureText(scheme, error, stderr) });
      });
    });
  };
}
