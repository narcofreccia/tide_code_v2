import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusLegendButton } from "./StatusLegendButton.tsx";

afterEach(cleanup);

describe("StatusLegendButton", () => {
  it("opens the legend from a labelled ? button", () => {
    render(<StatusLegendButton />);
    const trigger = screen.getByRole("button", { name: "Status legend" });
    expect(trigger.getAttribute("title")).toBe("What do the status symbols mean?");
    fireEvent.click(trigger);
    expect(screen.getByRole("table", { name: "Status legend" }).querySelectorAll("tr")).toHaveLength(9);
  });
});
