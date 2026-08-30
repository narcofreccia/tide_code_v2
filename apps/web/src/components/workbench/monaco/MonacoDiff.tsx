import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { languageForPath, setupMonaco } from "./monacoSetup.ts";
import { preferredTheme } from "./themes.ts";

setupMonaco();

/** Follows the OS colour scheme, like the rest of the shell. */
function useThemeName(): string {
  const [name, setName] = useState(preferredTheme);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return undefined;
    const update = (): void => setName(preferredTheme());
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return name;
}

export function MonacoDiff({
  path,
  original,
  modified,
  sideBySide,
}: {
  path: string;
  original: string;
  modified: string;
  sideBySide: boolean;
}) {
  const theme = useThemeName();
  return (
    <DiffEditor
      height="100%"
      theme={theme}
      original={original}
      modified={modified}
      language={languageForPath(path)}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        renderOverviewRuler: false,
      }}
    />
  );
}
