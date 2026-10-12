import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RateLimitBadge, rateLimitTitle } from "./RateLimitBadge.tsx";

afterEach(cleanup);

const NOW = 1_000_000_000;

describe("RateLimitBadge", () => {
  it("renders warning with the remaining share and the reset", () => {
    render(<RateLimitBadge limit={{ status: "warning", remainingPct: 12.4, resetsAt: NOW + 30 * 60_000, at: 1 }} now={NOW} />);
    expect(screen.getByLabelText(/rate limit warning/).textContent).toBe("⚠ 12% left · resets in 30m");
  });

  it("renders limited in the attention style", () => {
    render(<RateLimitBadge limit={{ status: "limited", at: 1 }} now={NOW} />);
    const badge = screen.getByLabelText("rate limit limited");
    expect(badge.textContent).toBe("⛔ limited");
    expect(badge.className).toMatch(/limited/);
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

  it("puts the harness wording first in the hover text", () => {
    const title = rateLimitTitle({ status: "warning", note: "weekly cap", remainingPct: 5, overage: true, at: 1 }, NOW);
    expect(title).toBe("weekly cap · 5% of the window left · running on overage");
  });
});
