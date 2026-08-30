import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Monaco is loaded lazily by the Changes tab; its chunk is expected to be large.
  build: { chunkSizeWarningLimit: 4096 },
});
