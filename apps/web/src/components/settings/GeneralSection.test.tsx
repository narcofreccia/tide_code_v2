import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection.tsx";
import { chooseOption } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("General settings", () => {
  it("stores the follow-up mode and limit policy", () => {
    render(<GeneralSection />);
    chooseOption("Follow-up default", "Queue");
    expect(localStorage.getItem("tide.followUpMode")).toBe("queue");
    chooseOption("Usage limit policy", "Resume at reset");
    expect(localStorage.getItem("tide.limitPolicy")).toBe("reset");
    expect(screen.getByText(/handoffs are lossy/)).toBeDefined();
  });
});
