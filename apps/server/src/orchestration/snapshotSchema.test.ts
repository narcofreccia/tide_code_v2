import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ReadModel } from "@tide/contracts";
import { MODEL_SCHEMA, MODEL_SCHEMA_HASH } from "./snapshots.ts";

/** Annotations that do not change what a stored model looks like; wording edits must not fail the test. */
const ANNOTATIONS = new Set(["description", "title", "$comment", "examples"]);
/** Keys whose value maps names to sub-schemas: the names are shape, kept as they are. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/** The schema as JSON with sorted keys and no annotations (symbol-keyed TypeBox internals are dropped by JSON anyway). */
function canonical(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(canonical);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema).sort()) {
    if (ANNOTATIONS.has(key)) continue;
    const value = (schema as Record<string, unknown>)[key];
    if (SCHEMA_MAPS.has(key) && typeof value === "object" && value !== null) {
      const map: Record<string, unknown> = {};
      for (const name of Object.keys(value).sort()) map[name] = canonical((value as Record<string, unknown>)[name]);
      out[key] = map;
    } else {
      out[key] = canonical(value);
    }
  }
  return out;
}

function readModelSchemaHash(): string {
  return createHash("sha256").update(JSON.stringify(canonical(ReadModel))).digest("hex");
}

describe("MODEL_SCHEMA", () => {
  it("is bumped whenever the ReadModel schema changes shape", () => {
    const actual = readModelSchemaHash();
    expect(
      actual,
      `The ReadModel TypeBox schema in @tide/contracts (packages/contracts/src/domain.ts) changed shape, so snapshots written by older builds no longer match it.\n` +
        `In apps/server/src/orchestration/snapshots.ts:\n` +
        `  1. bump MODEL_SCHEMA from ${MODEL_SCHEMA} to ${MODEL_SCHEMA + 1}\n` +
        `  2. set MODEL_SCHEMA_HASH = "${actual}"\n` +
        `(A projector change that keeps the shape needs the bump too, without this test noticing.)`,
    ).toBe(MODEL_SCHEMA_HASH);
  });

  it("ignores annotations and key order, but not names", () => {
    const a = { type: "object", description: "x", properties: { title: { type: "string", description: "y" }, b: { type: "number" } } };
    const b = { properties: { b: { type: "number" }, title: { type: "string" } }, type: "object" };
    expect(JSON.stringify(canonical(a))).toBe(JSON.stringify(canonical(b)));
    expect(JSON.stringify(canonical({ properties: { c: { type: "number" } } }))).not.toBe(JSON.stringify(canonical({ properties: { d: { type: "number" } } })));
  });
});
