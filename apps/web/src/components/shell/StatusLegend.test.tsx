import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusLegend } from "./StatusLegend.tsx";

afterEach(cleanup);

describe("StatusLegend", () => {
  it("opens from the ? button and lists every state with its meaning", () => {
    render(<StatusLegend />);
    fireEvent.click(screen.getByTitle("What do the status symbols mean?"));
    const table = screen.getByRole("table", { name: "Status legend" });
    for (const word of ["Idle", "Running", "Needs you", "Error", "Interrupted", "Limited", "Snoozed", "Merged"]) {
      expect(table.textContent).toContain(word);
    }
    expect(table.querySelectorAll("tr")).toHaveLength(8);
  });
});
