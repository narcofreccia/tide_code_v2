import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { languageForPath, setupMonaco } from "./monacoSetup.ts";
import { preferredTheme, subscribeTheme } from "./themes.ts";

setupMonaco();

/** Follows the OS colour scheme, like the rest of the shell. */
function useThemeName(): string {
  const [name, setName] = useState(preferredTheme);
  useEffect(() => subscribeTheme(() => setName(preferredTheme())), []);
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
