import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

const calls: string[] = [];

vi.mock("./monacoSetup.ts", () => ({ setupMonaco: () => undefined, languageForPath: () => "typescript" }));
vi.mock("./themes.ts", () => ({ preferredTheme: () => "tide-dark", subscribeTheme: () => () => undefined }));
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: {
    onMount?: (editor: unknown) => void;
    keepCurrentOriginalModel?: boolean;
    keepCurrentModifiedModel?: boolean;
  }) => {
    useEffect(() => {
      let models: { original: { dispose: () => void }; modified: { dispose: () => void } } | null = {
        original: { dispose: () => calls.push("original.dispose") },
        modified: { dispose: () => calls.push("modified.dispose") },
      };
      const editor = {
        getModel: () => models,
        setModel: (next: null) => {
          calls.push("setModel(null)");
          models = next;
        },
        dispose: () => calls.push("editor.dispose"),
      };
      props.onMount?.(editor);
      // mirrors @monaco-editor/react 4.7's own unmount: models first unless kept
      return () => {
        const current = editor.getModel();
        if (!props.keepCurrentOriginalModel) current?.original.dispose();
        if (!props.keepCurrentModifiedModel) current?.modified.dispose();
        editor.dispose();
      };
    }, []);
    return <div data-testid="diff-editor" />;
  },
}));

const { MonacoDiff } = await import("./MonacoDiff.tsx");

describe("MonacoDiff teardown", () => {
  it("detaches the models before disposing them, and never disposes an attached model", () => {
    render(<MonacoDiff path="a.ts" original="a" modified="b" sideBySide />);
    cleanup();
    expect(calls).toEqual(["setModel(null)", "original.dispose", "modified.dispose", "editor.dispose"]);
  });
});
