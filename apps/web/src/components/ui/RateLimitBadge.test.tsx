import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RateLimitBadge, rateLimitHead, rateLimitTitle } from "./RateLimitBadge.tsx";
import { ICONS } from "./icons.ts";

afterEach(cleanup);

const NOW = 1_000_000_000;

describe("RateLimitBadge", () => {
  it("renders warning with the remaining share and the reset", () => {
    render(<RateLimitBadge limit={{ status: "warning", remainingPct: 12.4, resetsAt: NOW + 30 * 60_000, at: 1 }} now={NOW} />);
    const badge = screen.getByLabelText(/rate limit warning/);
    expect(badge.textContent?.trim()).toBe("12% left · resets in 30m");
    expect(badge.querySelector("path")?.getAttribute("d")).toBe(ICONS.warning);
  });

  it("renders limited in the attention style", () => {
    render(<RateLimitBadge limit={{ status: "limited", at: 1 }} now={NOW} />);
    const badge = screen.getByLabelText("rate limit limited");
    expect(badge.textContent?.trim()).toBe("limited");
    expect(badge.querySelector("path")?.getAttribute("d")).toBe(ICONS.ban);
    expect(badge.className).toMatch(/limited/);
  });

  it("an exhausted overage window stays a warning that says what ran out", () => {
    render(<RateLimitBadge limit={{ status: "warning", note: "seven_day_overage_included 100% used (rejected)", remainingPct: 0, at: 1 }} now={NOW} />);
    const badge = screen.getByLabelText("rate limit warning");
    expect(badge.textContent?.trim()).toBe("overage used up");
    expect(badge.className).toMatch(/warning/);
  });

  it("renders nothing for ok or no report", () => {
    const { container } = render(
      <>
        <RateLimitBadge limit={{ status: "ok", at: 1 }} />
        <RateLimitBadge limit={undefined} />
      </>,
    );
    expect(container.textContent).toBe("");
  });

  it("maps each state to an icon and words", () => {
    expect(rateLimitHead({ status: "limited", at: 1 })).toEqual({ icon: "ban", text: "limited" });
    expect(rateLimitHead({ status: "warning", remainingPct: 40.6, at: 1 })).toEqual({ icon: "warning", text: "41% left" });
    expect(rateLimitHead({ status: "warning", at: 1 })).toEqual({ icon: "warning", text: "near limit" });
  });

  it("puts the harness wording first in the hover text", () => {
    const title = rateLimitTitle({ status: "warning", note: "weekly cap", remainingPct: 5, overage: true, at: 1 }, NOW);
    expect(title).toBe("weekly cap · 5% of the window left · running on overage");
  });
});
