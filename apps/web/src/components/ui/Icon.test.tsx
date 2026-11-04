import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Icon } from "./Icon.tsx";
import { ICONS, type IconName } from "./icons.ts";

afterEach(cleanup);

const NAMES = Object.keys(ICONS) as IconName[];

describe("Icon", () => {
  it.each(NAMES)("renders %s as an svg with path data", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    const d = svg?.querySelector("path")?.getAttribute("d") ?? "";
    expect(d).toMatch(/^M[-\d.]/);
    expect(d).not.toMatch(/NaN|undefined/);
  });

  it("covers the set the shell needs", () => {
    for (const name of ["menu", "inbox", "settings", "merge", "sun", "moon", "keyboard", "eye", "ban", "warning", "image", "file", "chat", "link"]) {
      expect(NAMES).toContain(name);
    }
  });

  it("is decorative by default", () => {
    const { container } = render(<Icon name="inbox" size={20} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("width")).toBe("20");
  });

  it("is an image with a name when labelled", () => {
    render(<Icon name="bell" label="Notifications" />);
    const img = screen.getByRole("img", { name: "Notifications" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });
});
