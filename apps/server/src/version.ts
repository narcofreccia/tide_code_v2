import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Replaced with a string literal by `bun build --define TIDE_BUILD_VERSION='"x.y.z"'`
 * (scripts/build-server-sidecar.sh). Under node it is never defined.
 */
declare const TIDE_BUILD_VERSION: string | undefined;

/** Bumped when the RPC/HTTP surface changes incompatibly; clients compare it via `GET /api/env`. */
export const PROTOCOL_VERSION = 1;

const ROOT_PACKAGE = "tide-code-v2";

/** Dev runs: walk up from this file to the workspace root `package.json` and read its version. */
export function rootPackageVersion(from: string = import.meta.dirname): string | undefined {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (pkg.name === ROOT_PACKAGE && typeof pkg.version === "string") return pkg.version;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function resolveVersion(): string {
  if (typeof TIDE_BUILD_VERSION === "string" && TIDE_BUILD_VERSION.length > 0) return TIDE_BUILD_VERSION;
  return rootPackageVersion() ?? "0.0.0-unknown";
}

/** The product version (root package.json), embedded at build time in the compiled sidecar. */
export const VERSION: string = resolveVersion();
