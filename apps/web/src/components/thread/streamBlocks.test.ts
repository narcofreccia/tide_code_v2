import { describe, expect, it } from "vitest";
import { advanceScan, emptyScan, endsInOpenFence, pendingStart, splitStreamingTail } from "./streamBlocks.ts";

const REPLY =
  "# Plan\n\nFirst paragraph.\n\n- one\n- two\n\n  still two\n\n- three\n\nAfter the list.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n    indented code\n\n    more\n\nLast words here and there";

/** Scans `text` in one go. */
function scanAll(text: string) {
  return advanceScan(emptyScan(), text);
}

describe("advanceScan", () => {
  it("settles a block at a blank line outside fences, never inside a list, fence or indented code", () => {
    const text = `${REPLY}\n`;
    const scan = scanAll(text);
    const blocks = [...scan.settled, text.slice(scan.starts.at(-1))];
    expect(blocks).toEqual([
      "# Plan\n\n",
      // a list item after a blank line may continue a list above: kept with the block before it
      "First paragraph.\n\n- one\n- two\n\n  still two\n\n- three\n\n",
      "After the list.\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n    indented code\n\n    more\n\n",
      "Last words here and there\n",
    ]);
    expect(blocks.join("")).toBe(text);
  });

  it("gives the same result fed one character at a time as in one go", () => {
    let scan = emptyScan();
    for (let i = 1; i <= REPLY.length; i++) scan = advanceScan(scan, REPLY.slice(0, i));
    const once = scanAll(REPLY);
    expect(scan.starts).toEqual(once.starts);
    expect(scan.settled).toEqual(once.settled);
    expect(scan.fences).toBe(once.fences);
  });

  it("starts over when the text is not an append", () => {
    const scan = advanceScan(emptyScan(), "a\n\nb\n\nc");
    expect(advanceScan(scan, "x\n\ny\n").settled).toEqual(["x\n\n"]);
  });

  it("does not split a reply with a reference or footnote definition", () => {
    expect(scanAll("see [x]\n\n[x]: https://example.com\n\nmore\n").noSplit).toBe(true);
    expect(scanAll("a[^1]\n\n[^1]: note\n").noSplit).toBe(true);
  });

  it("knows when the reply ends inside a fence, the partial last line included", () => {
    const open = "a\n\n```mermaid\ngraph TD";
    expect(endsInOpenFence(scanAll(open), open)).toBe(true);
    const closing = "a\n\n```mermaid\ngraph TD\n```";
    expect(endsInOpenFence(scanAll(closing), closing)).toBe(false);
  });
});

describe("pendingStart", () => {
  it("settles the block above once the partial line visibly starts a new one", () => {
    const text = "One.\n\nTwo is still being wri";
    expect(pendingStart(scanAll(text), text)).toBe(6);
  });

  it("waits while the partial line could still continue a list or indented block", () => {
    for (const text of ["- a\n\n- b", "- a\n\n  more", "1. a\n\n2", "x\n\n[ref"]) {
      expect(pendingStart(scanAll(text), text)).toBeUndefined();
    }
  });

  it("never inside a fence", () => {
    const text = "```\na\n\nb";
    expect(pendingStart(scanAll(text), text)).toBeUndefined();
  });
});

describe("splitStreamingTail with a scanned fence parity", () => {
  it("agrees with the counting version on every prefix", () => {
    const text = `${REPLY}\n\n\`\`\`sh\nls\n\`\`\`\n\nw0 w1 w2 w3 w4 w5`;
    let scan = emptyScan();
    for (let i = 1; i <= text.length; i++) {
      const prefix = text.slice(0, i);
      scan = advanceScan(scan, prefix);
      expect(splitStreamingTail(prefix, 12, endsInOpenFence(scan, prefix))).toEqual(splitStreamingTail(prefix));
    }
  });
});
