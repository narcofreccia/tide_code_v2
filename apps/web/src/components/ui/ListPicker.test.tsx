import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ListPicker, ListPickerList, stepCursor } from "./ListPicker.tsx";

const PATHS = ["src/app.ts", "src/state/ui.ts", "README.md", "docs/design/ui.md"];

function renderPicker(props: Partial<Parameters<typeof ListPicker<string>>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <ListPicker
      items={PATHS}
      itemKey={(p) => p}
      renderItem={(p) => <span>{p}</span>}
      onPick={onPick}
      onClose={onClose}
      label="Files"
      inputLabel="Find"
      {...props}
    />,
  );
  return { onPick, onClose, input: screen.getByLabelText("Find") };
}

function options(): string[] {
  return within(screen.getByRole("listbox", { name: "Files" }))
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

afterEach(cleanup);

describe("ListPicker", () => {
  it("focuses the query box and lists everything for an empty query", () => {
    const { input } = renderPicker();
    expect(document.activeElement).toBe(input);
    expect(options()).toEqual(PATHS);
  });

  it("fuzzy-filters as the user types", () => {
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "uimd" } });
    expect(options()).toEqual(["docs/design/ui.md"]);
  });

  it("walks the list with arrows and picks the active row on Enter", () => {
    const { input, onPick } = renderPicker();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.textContent).toBe("src/state/ui.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("src/state/ui.ts");
  });

  it("clamps the cursor at both ends", () => {
    expect(stepCursor("ArrowUp", 0, 3)).toBe(0);
    expect(stepCursor("ArrowDown", 2, 3)).toBe(2);
    expect(stepCursor("ArrowDown", 0, 0)).toBe(0);
    expect(stepCursor("Enter", 1, 3)).toBeUndefined();
  });

  it("closes on Escape and picks on click", () => {
    const { input, onClose, onPick } = renderPicker();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("option", { name: "README.md" }));
    expect(onPick).toHaveBeenCalledWith("README.md");
  });

  it("shows the empty note, or nothing when empty is null", () => {
    const { input } = renderPicker({ empty: "No matching file." });
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText("No matching file.")).toBeDefined();
    cleanup();
    const second = renderPicker({ empty: null });
    fireEvent.change(second.input, { target: { value: "zzzz" } });
    expect(screen.queryByText("Nothing matches.")).toBeNull();
  });

  it("uses a custom rank instead of fuzzy matching when given one", () => {
    const { input } = renderPicker({ rank: (_q, items) => [...items].reverse() });
    fireEvent.change(input, { target: { value: "anything" } });
    expect(options()[0]).toBe("docs/design/ui.md");
  });
});

describe("ListPickerList", () => {
  it("picks on mousedown without moving focus when asked to", () => {
    const onPick = vi.fn();
    render(
      <ListPickerList
        items={["a.ts", "b.ts"]}
        itemKey={(p) => p}
        renderItem={(p) => p}
        active={1}
        onPick={onPick}
        label="Mention a file"
        pickOn="mousedown"
      />,
    );
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("b.ts");
    const event = fireEvent.mouseDown(screen.getByRole("option", { name: "a.ts" }));
    expect(event).toBe(false); // default prevented: the textarea keeps the caret
    expect(onPick).toHaveBeenCalledWith("a.ts");
  });
});
