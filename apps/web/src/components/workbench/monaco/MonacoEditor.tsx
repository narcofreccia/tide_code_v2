import { useEffect, useRef, useState } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import { languageForPath, setupMonaco } from "./monacoSetup.ts";
import { preferredTheme, subscribeTheme } from "./themes.ts";

setupMonaco();

type EditorInstance = Parameters<OnMount>[0];

/** Follows the theme setting (explicit choice, else the OS colour scheme). */
function useThemeName(): string {
  const [name, setName] = useState(preferredTheme);
  useEffect(() => subscribeTheme(() => setName(preferredTheme())), []);
  return name;
}

export interface RevealRequest {
  line: number;
  column: number;
  /** changing this re-reveals the same position */
  nonce: number;
}

/**
 * Writable editor for one file tab. Cursor and scroll are handed back through
 * `onSaveViewState` so re-selecting the tab lands where the user left it.
 */
export function MonacoEditor({
  path,
  value,
  readOnly = false,
  onChange,
  onCursor,
  initialViewState,
  onSaveViewState,
  reveal,
}: {
  path: string;
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onCursor?: (line: number, column: number) => void;
  initialViewState?: unknown;
  onSaveViewState?: (state: unknown) => void;
  reveal?: RevealRequest;
}) {
  const theme = useThemeName();
  const editor = useRef<EditorInstance | null>(null);
  const saveState = useRef(onSaveViewState);
  saveState.current = onSaveViewState;

  const apply = (target: EditorInstance, at: RevealRequest): void => {
    target.setPosition({ lineNumber: at.line, column: at.column });
    target.revealLineInCenter(at.line);
    target.focus();
  };

  const onMount: OnMount = (instance) => {
    editor.current = instance;
    if (initialViewState) instance.restoreViewState(initialViewState as never);
    if (reveal) apply(instance, reveal);
    instance.onDidChangeCursorPosition((event) => {
      onCursor?.(event.position.lineNumber, event.position.column);
    });
  };

  useEffect(() => {
    const instance = editor.current;
    if (instance && reveal) apply(instance, reveal);
  }, [reveal?.nonce]);

  useEffect(
    () => () => {
      const instance = editor.current;
      if (instance) saveState.current?.(instance.saveViewState());
    },
    [],
  );

  return (
    <Editor
      height="100%"
      theme={theme}
      path={path}
      language={languageForPath(path)}
      value={value}
      onMount={onMount}
      onChange={(next) => onChange?.(next ?? "")}
      options={{
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        tabSize: 2,
      }}
    />
  );
}
