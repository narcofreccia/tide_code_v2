import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isEditableTarget, useEscape } from "./useEscape.ts";

afterEach(cleanup);

function Layer({ onEscape, children }: { onEscape: () => void; children?: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEscape(onEscape, { root });
  return <div ref={root}>{children}</div>;
}

describe("useEscape", () => {
  it("knows typing targets", () => {
    const make = (html: string): HTMLElement => {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.append(host);
      return host.firstElementChild as HTMLElement;
    };
    expect(isEditableTarget(make("<input>"))).toBe(true);
    expect(isEditableTarget(make('<input type="checkbox">'))).toBe(false);
    expect(isEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(make("<select></select>"))).toBe(true);
    expect(isEditableTarget(make('<div contenteditable="true"><b>x</b></div>').firstElementChild)).toBe(true);
    expect(isEditableTarget(make("<button>x</button>"))).toBe(false);
    document.body.innerHTML = "";
  });

  it("leaves a popover or menu opened over the layer to close itself", () => {
    const onEscape = vi.fn();
    const { rerender } = render(
      <>
        <Layer onEscape={onEscape} />
        <div role="menu" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
    rerender(<Layer onEscape={onEscape} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("still handles Esc when the layer itself sits inside a popover", () => {
    const onEscape = vi.fn();
    render(
      <div data-tide-layer="">
        <Layer onEscape={onEscape}>
          <button type="button">inside</button>
        </Layer>
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("ignores a key another handler already took, and modified Esc", () => {
    const onEscape = vi.fn();
    render(
      <Layer onEscape={onEscape}>
        <input aria-label="rename" onKeyDown={(e) => e.key === "Escape" && e.preventDefault()} />
      </Layer>,
    );
    fireEvent.keyDown(screen.getByLabelText("rename"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape", metaKey: true });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
