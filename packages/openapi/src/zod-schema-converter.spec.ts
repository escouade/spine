import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { z as zClassic } from "zod";
import { ZodSchemaConverter } from "./zod-schema-converter";

// Test schemas are authored with the `zod/v4` surface (the flavor requirement) —
// see the v3-classic rejection test below for the other side of that contract.

describe("ZodSchemaConverter", () => {
  it("converts a zod object to a draft-2020-12 fragment (FR-C2)", () => {
    const converter = new ZodSchemaConverter();
    const frag = converter.toJsonSchema(
      z.object({ id: z.string(), n: z.number().optional() })
    );

    expect(frag).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("projects the input vs output side of a transform (FR-C6)", () => {
    const converter = new ZodSchemaConverter();
    const schema = z.object({ page: z.number().default(1) });

    const input = converter.toJsonSchema(schema, { io: "input" });
    const output = converter.toJsonSchema(schema, { io: "output" });

    // A field with a default is optional on the way in, required on the way out.
    expect(input.required).toBeUndefined();
    expect(output.required).toEqual(["page"]);

    // Omitted io defaults to "output": the defaulted field projects as required.
    const defaulted = converter.toJsonSchema(schema);
    expect(defaulted.required).toEqual(["page"]);
  });

  it("maps Date to string/date-time and bigint to string (FR-C5)", () => {
    const converter = new ZodSchemaConverter();
    const frag = converter.toJsonSchema(
      z.object({ d: z.date(), b: z.bigint() })
    );

    expect(frag).toMatchObject({
      properties: {
        d: { type: "string", format: "date-time" },
        b: { type: "string" },
      },
    });
  });

  it("hoists a reused schema to $defs and references it with $ref", () => {
    const converter = new ZodSchemaConverter();
    const Inner = z.object({ x: z.string() });
    const frag = converter.toJsonSchema(z.object({ a: Inner, b: Inner }));

    // Fragment-level $defs — relocating to components/schemas is the builder's job.
    expect(frag.$defs).toBeDefined();
    const props = frag.properties as Record<string, { $ref?: string }>;
    expect(props.a.$ref).toBe(props.b.$ref);
    expect(props.a.$ref?.startsWith("#/$defs/")).toBe(true);
  });

  it("logs an unrepresentable type once and emits an open schema {}", () => {
    const warn = vi.fn();
    const converter = new ZodSchemaConverter({ warn });

    const first = converter.toJsonSchema(z.object({ s: z.symbol() }));
    // Converting a second time must NOT log the same type again (dedupe).
    converter.toJsonSchema(z.object({ s: z.symbol() }));

    const props = first.properties as Record<string, unknown>;
    expect(props.s).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("symbol");
  });

  it("does not warn for representable open schemas (z.any / z.unknown)", () => {
    const warn = vi.fn();
    const converter = new ZodSchemaConverter({ warn });

    const frag = converter.toJsonSchema(
      z.object({ a: z.any(), u: z.unknown() })
    );

    // `{}` IS the correct fragment for any/unknown — not an unrepresentable fallback.
    expect(warn).not.toHaveBeenCalled();
    const props = frag.properties as Record<string, unknown>;
    expect(props.a).toEqual({});
    expect(props.u).toEqual({});
  });

  it("rejects a classic zod-v3 schema (flavor guard, seeds the zod-pin test)", () => {
    const converter = new ZodSchemaConverter();
    // A v3-classic schema fed to the v4 converter throws — the documented
    // single-flavor contract. Story 1.8 extends this into the full pin triad.
    const v3 = zClassic.object({ x: zClassic.string() });
    expect(() =>
      converter.toJsonSchema(v3 as unknown as { parse(i: unknown): unknown })
    ).toThrow();
  });
});
