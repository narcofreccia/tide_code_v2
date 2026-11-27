import { describe, expect, it } from "vitest";
import { elicitationForm } from "./elicitation.ts";

describe("elicitationForm", () => {
  it("leaves out an optional <name>_other next to an enum and maps titles back to consts", () => {
    const form = elicitationForm({
      mode: "form",
      message: "The agent has a question.",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Pick", oneOf: [{ const: "1", title: "Red" }, { const: "2", title: "Blue" }] },
          q1_other: { type: "string", title: "Other" },
          q2: { type: "array", title: "Many", items: { anyOf: [{ const: "1", title: "A" }, { const: "2", title: "B" }] } },
        },
      },
    });
    expect(form?.questions).toEqual([
      { id: "q1", text: "Pick", options: [{ label: "Red" }, { label: "Blue" }] },
      { id: "q2", text: "Many", multi: true, options: [{ label: "A" }, { label: "B" }] },
    ]);
    expect(form?.toContent({ q1: "Blue", q2: ["A", "B"] })).toEqual({ q1: "2", q2: ["1", "2"] });
    expect(form?.toContent({})).toBeUndefined();
  });

  it("a free-text field with no enum sibling stays; the message leads an untitled first field; head wins", () => {
    const params = { message: "Deploy?", requestedSchema: { type: "object", properties: { note: { type: "string" }, x_other: { type: "string" } } } };
    expect(elicitationForm(params)?.questions.map((q) => q.text)).toEqual(["Deploy?\nnote", "x_other"]);
    expect(elicitationForm(params, { head: "[srv] " })?.questions[0]?.text).toBe("[srv] note");
  });
});
