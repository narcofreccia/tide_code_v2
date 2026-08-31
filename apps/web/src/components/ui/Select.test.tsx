import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { Select, type SelectOption } from "./Select.tsx";

afterEach(cleanup);

const FRUIT: SelectOption<string>[] = [
  { value: "apple", label: "Apple", group: "pome" },
  { value: "pear", label: "Pear", group: "pome", description: "soft" },
  { value: "plum", label: "Plum", group: "stone" },
  { value: "sloe", label: "Sloe", group: "stone", disabled: true, title: "out of season" },
];

function Harness({
  options = FRUIT,
  onSelect,
  searchable,
  disabled,
}: {
  options?: SelectOption<string>[];
  onSelect?: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("apple");
  return (
    <Select
      label="Fruit"
      value={value}
      options={options}
      searchable={searchable}
      disabled={disabled}
      onSelect={(next) => {
        setValue(next);
        onSelect?.(next);
      }}
    />
  );
}

const listbox = (): HTMLElement => screen.getByRole("listbox", { name: "Fruit" });
const open = (): void => {
  fireEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
};

describe("Select", () => {
  it("opens, shows the options and closes on Escape", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(listbox()).getAllByRole("option")).toHaveLength(4);

    fireEvent.keyDown(listbox(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects with the mouse and reflects the choice on the trigger", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    fireEvent.click(within(listbox()).getByRole("option", { name: /Plum/ }));
    expect(onSelect).toHaveBeenCalledWith("plum");
    expect(screen.getByRole("combobox", { name: "Fruit" }).textContent).toContain("Plum");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("walks with the keyboard and commits on Enter, skipping disabled options", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    // apple is active (selected); ↓ ↓ lands on plum, ↓ skips the disabled sloe back to apple
    fireEvent.keyDown(listbox(), { key: "ArrowDown" });
    fireEvent.keyDown(listbox(), { key: "ArrowDown" });
    fireEvent.keyDown(listbox(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("plum");

    open();
    fireEvent.keyDown(listbox(), { key: "End" });
    fireEvent.keyDown(listbox(), { key: "Enter" });
    // End lands on the last *enabled* option, never the disabled sloe
    expect(onSelect).toHaveBeenLastCalledWith("plum");
  });

  it("refuses a disabled option and surfaces its reason as a tooltip", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    const sloe = within(listbox()).getByRole("option", { name: /Sloe/ });
    expect(sloe.getAttribute("aria-disabled")).toBe("true");
    expect(sloe.getAttribute("title")).toBe("out of season");
    fireEvent.click(sloe);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox", { name: "Fruit" })).toBeDefined();
  });

  it("renders group headers and descriptions", () => {
    render(<Harness />);
    open();
    const panel = listbox();
    expect(within(panel).getByText("pome")).toBeDefined();
    expect(within(panel).getByText("stone")).toBeDefined();
    expect(within(panel).getByText("soft")).toBeDefined();
  });

  it("filters when searchable", () => {
    render(<Harness searchable />);
    open();
    const filter = screen.getByLabelText("Filter Fruit");
    fireEvent.change(filter, { target: { value: "plu" } });
    const names = within(listbox())
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names.some((n) => n?.includes("Plum"))).toBe(true);
    expect(names.some((n) => n?.includes("Apple"))).toBe(false);

    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(within(listbox()).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeDefined();
  });

  it("shows the filter automatically past eight options", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
    render(<Harness options={many} />);
    open();
    expect(screen.getByLabelText("Filter Fruit")).toBeDefined();
  });

  it("type-ahead jumps to a matching option", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    fireEvent.keyDown(listbox(), { key: "p" });
    fireEvent.keyDown(listbox(), { key: "e" });
    fireEvent.keyDown(listbox(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("pear");
  });

  it("portals the panel to the body and positions it fixed", () => {
    const { container } = render(<Harness />);
    open();
    const panel = listbox().parentElement as HTMLElement;
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
    expect(panel.style.position).toBe("fixed");
  });

  it("closes on an outside click without selecting", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not open when disabled", () => {
    render(<Harness disabled />);
    fireEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
