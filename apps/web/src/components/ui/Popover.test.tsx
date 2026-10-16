import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Popover } from "./Popover.tsx";
import { Select } from "./Select.tsx";

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState("claude");
  return (
    <>
      <span data-testid="value">{value}</span>
      <Popover label="New thread">
        {() => (
          <Select
            label="Agent"
            value={value}
            options={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
              { value: "pi", label: "Pi" },
            ]}
            onSelect={setValue}
          />
        )}
      </Popover>
      <button type="button">outside</button>
    </>
  );
}

const pick = (name: string): void => {
  const option = screen.getByRole("option", { name });
  fireEvent.mouseDown(option);
  fireEvent.click(option);
};

describe("Popover", () => {
  it("keeps the panel open when a portalled Select option is clicked", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    pick("Codex");
    expect(screen.getByTestId("value").textContent).toBe("codex");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("walks and commits the Select with the keyboard inside the panel", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("pi");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("still closes on a click outside every layer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
