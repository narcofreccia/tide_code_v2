/** In-memory repo shapes mirroring Andrea's five repos (trimmed to what the scanner reads). */
const json = (v: unknown): string => JSON.stringify(v, null, 2);

const TAURI_VITE = `import { defineConfig } from "vite";
const host = process.env.TAURI_DEV_HOST;
export default defineConfig(async () => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
  },
}));
`;

export const tideReel: Record<string, string> = {
  "pyproject.toml": `[project]\nname = "tidereel"\ndependencies = ["numpy", "opencv-python"]\n`,
  "gui/package.json": json({ name: "gui", scripts: { dev: "vite dev", build: "vite build", preview: "vite preview", tauri: "tauri" } }),
  "gui/package-lock.json": "{}",
  "gui/vite.config.js": TAURI_VITE,
  "gui/src-tauri/tauri.conf.json": json({ build: { beforeDevCommand: "npm run dev", devUrl: "http://localhost:1420", frontendDist: "../build" } }),
  "gui/src/main.ts": "console.log(1)\n",
};

export const tideBackend: Record<string, string> = {
  "requirements.txt": "fastapi==0.115.0\nuvicorn[standard]==0.30.0\ncelery==5.4.0\nredis==5.0.0\npython-dotenv\n",
  "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
  "app/celery_app.py": "from celery import Celery\ncelery = Celery('app')\n",
  "app/config.py": "from dotenv import load_dotenv\nload_dotenv()\n",
  "venv/bin/activate": "# venv\n",
  "venv/lib/site.py": "load_dotenv(override=True)\n",
  ".env": "CLIENT_URL=http://localhost:8081\nREDIS_URL=redis://localhost:6379\nSECRET_KEY=hunter2\n",
  Procfile: "web: uvicorn app.main:app --host 0.0.0.0 --port $PORT\nworker: celery -A app.celery_app.celery worker\n",
};

export const tideFrontend: Record<string, string> = {
  "package.json": json({ name: "frontend", scripts: { dev: "vite", build: "vite build", start: "node server.js", preview: "vite preview" } }),
  "package-lock.json": "{}",
  "vite.config.js": `import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [],\n  server: { port: 8081 },\n});\n`,
  "server.js": "const PORT = process.env.PORT || 8081;\n",
  "src/env.js": "require('dotenv').config({ override: true });\n",
  ".env": "PORT=8081\nVITE_API_URL=http://localhost:8000\nVITE_MAPS_API_KEY=abc # inline\n",
};

export const tidePos2: Record<string, string> = {
  "package.json": json({
    name: "tide-pos",
    scripts: {
      "build:shared": "pnpm --filter @tide/shared build",
      dev: "pnpm build:shared && pnpm --filter @tide/desktop dev",
      tauri: "pnpm --filter @tide/desktop tauri",
      "tauri:dev": "pnpm build:shared && pnpm --filter @tide/desktop tauri dev",
    },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "apps/desktop/package.json": json({ name: "@tide/desktop", scripts: { dev: "vite dev", build: "vite build", tauri: "tauri" } }),
  "apps/desktop/vite.config.ts": TAURI_VITE,
  "apps/desktop/src-tauri/tauri.conf.json": json({ build: { beforeDevCommand: "pnpm --filter @tide/shared build && pnpm dev", devUrl: "http://localhost:1420" } }),
  "apps/desktop/src-tauri/src/main.rs": "fn main() {}\n",
  "packages/shared/package.json": json({ name: "@tide/shared", scripts: { build: "tsc" } }),
  ".env": "TIDE_SYNC_PORT=8080\nTIDE_DEV_BASE_URL=http://localhost:8000\n",
};

export const tidePosApp: Record<string, string> = {
  "package.json": json({ name: "pos-app", scripts: { start: "expo start", "start:dev": "APP_ENV=development expo start --clear", ios: "expo run:ios" }, dependencies: { expo: "~52.0.0" } }),
  "package-lock.json": "{}",
  "app.config.ts": "import { ExpoConfig } from 'expo/config';\nexport default (): ExpoConfig => ({ name: 'pos' });\n",
  "src/config.ts": "export const x = 1;\n",
  ".env": "DEV_SERVER_URL=http://192.168.1.50:8000#http://localhost:5000\n",
};
