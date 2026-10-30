import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildId = Date.now().toString(36);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // the service worker is a second entry emitted unhashed at /sw.js (root scope), versioned by this id
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: {
    // Monaco is loaded lazily by the Changes tab; its chunk is expected to be large.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/sw/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
