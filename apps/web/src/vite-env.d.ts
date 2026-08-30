/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TIDE_URL?: string;
  readonly VITE_TIDE_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
