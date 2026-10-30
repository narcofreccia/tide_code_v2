import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Pill } from "./Pill.tsx";
import { Card } from "./Card.tsx";

afterEach(cleanup);

describe("Pill", () => {
  it("is md by default and sm on request, with a tooltip", () => {
    render(
      <>
        <Pill tone="ok">primary</Pill>
        <Pill size="sm" title="Runs on box">
          box
        </Pill>
      </>,
    );
    expect(screen.getByText("primary").getAttribute("data-size")).toBe("md");
    const tag = screen.getByText("box");
    expect(tag.getAttribute("data-size")).toBe("sm");
    expect(tag.getAttribute("title")).toBe("Runs on box");
  });
});

describe("Card", () => {
  it("draws an optional header with actions over its body", () => {
    render(
      <Card header="Machines" actions={<button type="button">Add</button>} label="Machines card">
        <p>two machines</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Machines card" });
    expect(card.querySelector("h3")?.textContent).toBe("Machines");
    expect(card.textContent).toContain("Add");
    expect(card.textContent).toContain("two machines");
  });
});
