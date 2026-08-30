import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";
import { defineThemes } from "./themes.ts";

/**
 * Wires `@monaco-editor/react` to the bundled monaco instead of its CDN loader.
 * Only the base worker is registered: a read-only diff needs tokenisation, not
 * language services.
 */
let ready = false;

export function setupMonaco(): void {
  if (ready) return;
  ready = true;
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  defineThemes(monaco);
  loader.config({ monaco });
}

/** Best-effort language id for syntax colouring, from the file extension. */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot);
  for (const language of monaco.languages.getLanguages() as {
    id: string;
    extensions?: string[];
    filenames?: string[];
  }[]) {
    if (ext && language.extensions?.includes(ext)) return language.id;
    if (language.filenames?.some((f: string) => f.toLowerCase() === name)) return language.id;
  }
  return "plaintext";
}
