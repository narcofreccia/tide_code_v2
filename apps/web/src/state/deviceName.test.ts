import { describe, expect, it } from "vitest";
import { deviceNameFor } from "./deviceName.ts";

describe("deviceNameFor", () => {
  it("names the desktop shell and common browsers", () => {
    expect(deviceNameFor("anything", true)).toBe("Tide desktop");
    expect(deviceNameFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", false)).toBe("Safari on macOS");
    expect(deviceNameFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0", false)).toBe("Edge on Windows");
    expect(deviceNameFor("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", false)).toBe("Firefox on Linux");
    expect(deviceNameFor("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1", false)).toBe("Chrome on iOS");
    expect(deviceNameFor("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36", false)).toBe("Chrome on Android");
    expect(deviceNameFor("curl/8", false)).toBe("Browser");
  });
});
