import { describe, expect, it } from "vitest";
import { payloadBlock, WEBHOOK_PROMPT_MAX } from "./webhooks.ts";

describe("payloadBlock", () => {
  it("fences the body, with a longer fence when the body has backticks", () => {
    expect(payloadBlock(Buffer.from("hi"), "text/plain")).toBe("Webhook payload:\n```\nhi\n```");
    expect(payloadBlock(Buffer.from("a ``` b"), undefined)).toBe("Webhook payload:\n````\na ``` b\n````");
    expect(payloadBlock(Buffer.alloc(0), undefined)).toBe("Webhook fired (empty body).");
  });

  it("cuts at 8 KB and says so", () => {
    const block = payloadBlock(Buffer.from("é".repeat(WEBHOOK_PROMPT_MAX)), "application/json");
    expect(block.startsWith("Webhook payload:\n```json\n")).toBe(true);
    expect(block).toContain(`… (truncated, ${WEBHOOK_PROMPT_MAX * 2} bytes total)`);
    expect(block).not.toContain("�");
    expect(Buffer.byteLength(block)).toBeLessThan(WEBHOOK_PROMPT_MAX + 200);
  });
});
