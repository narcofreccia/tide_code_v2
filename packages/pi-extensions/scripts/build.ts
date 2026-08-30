import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Transpiles the extension to `dist/tide-bridge.js` so the driver can hand pi a plain `.js`
 * path (pi loads `.ts` too, which the driver uses as the dev fallback). pi resolves the
 * `typebox` / `@earendil-works/*` imports from this package's own node_modules, so they stay
 * external; everything of ours is bundled in, which keeps `dist` a single file.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src", "tide-bridge.ts")],
  outfile: join(root, "dist", "tide-bridge.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
});
console.log("built dist/tide-bridge.js");
