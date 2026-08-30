import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Absolute path handed to `pi -e`. Prefers the built `dist/tide-bridge.js`; falls back to
 * `src/tide-bridge.ts`, which pi loads directly (it runs TypeScript extensions), so a fresh
 * checkout works before `pnpm --filter @tide/pi-extensions build` has run.
 */
export function resolveBridgePath(from = import.meta.url): string | undefined {
  try {
    const require = createRequire(from);
    // "./protocol" is the one subpath export whose target is a real file on disk.
    const protocol = require.resolve("@tide/pi-extensions/protocol");
    const root = dirname(dirname(protocol));
    const built = join(root, "dist", "tide-bridge.js");
    if (existsSync(built)) return built;
    const source = join(root, "src", "tide-bridge.ts");
    return existsSync(source) ? source : undefined;
  } catch {
    return undefined;
  }
}
