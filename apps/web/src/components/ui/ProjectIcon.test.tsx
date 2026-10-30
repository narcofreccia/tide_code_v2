import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ProjectIcon } from "./ProjectIcon.tsx";

afterEach(cleanup);

describe("ProjectIcon", () => {
  it("draws a data icon as an image", () => {
    const { container } = render(<ProjectIcon project={{ title: "Tide", icon: { kind: "data", value: "data:image/png;base64,AAAA" } }} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(img?.getAttribute("data-icon")).toBe("data");
  });

  it("draws only the first grapheme of an emoji", () => {
    const { container } = render(<ProjectIcon project={{ title: "Tide", icon: { kind: "emoji", value: "🚀🔥" } }} />);
    expect(container.querySelector("[data-icon=emoji]")?.textContent).toBe("🚀");
  });

  it("falls back to the first letter", () => {
    const { container } = render(<ProjectIcon project={{ title: "tide" }} />);
    expect(container.querySelector("[data-icon=letter]")?.textContent).toBe("T");
  });
});
