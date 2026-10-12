import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Absolute path handed to `pi -e`. Prefers the built `dist/tide-bridge.js`; falls back to
 * `src/tide-bridge.ts`, which pi loads directly (it runs TypeScript extensions), so a fresh
 * checkout works before `pnpm --filter @tide/pi-extensions build` has run — and so does a
 * checkout whose `dist` is older than the source it was built from (dist is gitignored, so a
 * stale build would otherwise silently load an old bridge).
 */
export function resolveBridgePath(from = import.meta.url): string | undefined {
  try {
    const require = createRequire(from);
    // "./protocol" is the one subpath export whose target is a real file on disk.
    const protocol = require.resolve("@tide/pi-extensions/protocol");
    const root = dirname(dirname(protocol));
    const built = join(root, "dist", "tide-bridge.js");
    const source = join(root, "src", "tide-bridge.ts");
    if (!existsSync(source)) return existsSync(built) ? built : undefined;
    if (!existsSync(built)) return source;
    const sources = ["tide-bridge.ts", "protocol.ts", "readonly-shell.ts"].map((name) => join(root, "src", name)).filter((path) => existsSync(path));
    const newest = Math.max(...sources.map((path) => statSync(path).mtimeMs));
    return statSync(built).mtimeMs >= newest ? built : source;
  } catch {
    return undefined;
  }
}
