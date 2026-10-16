import { useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { languageForPath, setupMonaco } from "./monacoSetup.ts";
import { preferredTheme, subscribeTheme } from "./themes.ts";

setupMonaco();

/** Follows the painted theme: the explicit Settings choice (`data-theme`), else the OS scheme. */
function useThemeName(): string {
  const [name, setName] = useState(preferredTheme);
  useEffect(() => subscribeTheme(() => setName(preferredTheme())), []);
  return name;
}

type DiffEditorInstance = Parameters<DiffOnMount>[0];

/**
 * `@monaco-editor/react` disposes the text models before the diff editor on
 * unmount, which trips Monaco's "TextModel got disposed before DiffEditorWidget
 * model got reset". The library is told to keep its models; this hook detaches
 * them (`setModel(null)`) and only then disposes them. Parent effects clean up
 * before child ones on unmount, so this runs before the library disposes the
 * editor itself.
 */
export function useSafeDiffTeardown(): DiffOnMount {
  const editor = useRef<DiffEditorInstance | null>(null);
  useEffect(
    () => () => {
      const current = editor.current;
      editor.current = null;
      if (!current) return;
      const models = current.getModel();
      current.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
    },
    [],
  );
  return (instance) => {
    editor.current = instance;
  };
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
  const onMount = useSafeDiffTeardown();
  return (
    <DiffEditor
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={onMount}
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
