import { describe, expect, it } from "vitest";
import { clampPreviewHeight, fenceLanguage, newTabDocument } from "./visual.ts";

describe("visual helpers", () => {
  it("nests the new-tab html in a sandboxed frame, escaped", () => {
    const doc = newTabDocument('<p class="x">a & b</p>');
    expect(doc).toContain('sandbox="allow-scripts"');
    expect(doc).toContain('srcdoc="&lt;p class=&quot;x&quot;&gt;a &amp; b&lt;/p&gt;"');
  });

  it("reads fence languages and clamps the preview height", () => {
    expect(fenceLanguage("language-HTML")).toBe("html");
    expect(fenceLanguage(undefined)).toBeUndefined();
    expect(clampPreviewHeight(10)).toBe(120);
    expect(clampPreviewHeight(5000)).toBe(1200);
  });
});
