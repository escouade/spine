import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ZodSchemaConverter } from "./zod-schema-converter";

/**
 * Story 1.8 — zod-pin shape-guard (R5, NFR-7).
 *
 * `@spinejs/openapi` pins `zod` exact (`3.25.76`) because the builder depends on the precise shape of
 * `z.toJSONSchema`'s output. These tests lock that shape at the {@link ZodSchemaConverter} boundary
 * (the port contract the builder consumes). A `zod` bump that drifts any of these fragments fails
 * HERE — with a precise, self-explaining message — instead of surfacing as an opaque whole-document
 * golden diff (`golden-document.spec.ts`). Each assertion is annotated with the builder step it guards.
 *
 * Shapes were captured empirically under `zod@3.25.76`; do not edit them to make a bump pass — a
 * failure means the assumption the builder is built on changed and the builder must be re-verified.
 */

const conv = new ZodSchemaConverter();
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

describe("zod-pin shape-guard (R5, NFR-7)", () => {
  it("emits the draft-2020-12 dialect marker (OpenAPI 3.1)", () => {
    // The builder strips `$schema` while assembling; if zod stopped emitting it the strip would be a
    // silent no-op — lock its presence here.
    expect(conv.toJsonSchema(z.string() as never)).toEqual({
      $schema: DIALECT,
      type: "string",
    });
  });

  it("defaults io to output: additionalProperties:false + required", () => {
    // FR-C6: responses convert with io:'output'. Omitting `io` MUST behave as 'output' (zod's default),
    // otherwise response bodies would silently project as input (defaulted fields optional).
    const omitted = conv.toJsonSchema(z.object({ a: z.string() }) as never);
    const output = conv.toJsonSchema(z.object({ a: z.string() }) as never, {
      io: "output",
    });
    const expected = {
      $schema: DIALECT,
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(omitted).toEqual(expected);
    expect(output).toEqual(expected);
  });

  it("io:input drops additionalProperties (open request bodies)", () => {
    expect(
      conv.toJsonSchema(z.object({ a: z.string() }) as never, { io: "input" })
    ).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("a .default() field is optional on input, required on output", () => {
    // FR-C6: request bodies (io:'input') → defaulted field optional; responses (io:'output') → required.
    const withDefault = z.object({ n: z.string().default("x") });
    expect(conv.toJsonSchema(withDefault as never, { io: "input" })).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: { n: { default: "x", type: "string" } },
    });
    expect(conv.toJsonSchema(withDefault as never, { io: "output" })).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: { n: { default: "x", type: "string" } },
      required: ["n"],
      additionalProperties: false,
    });
  });

  it("a recursive schema self-refs with { $ref: '#' }", () => {
    // cycles:'ref' → a doc-root self-reference; the builder rewrites it to the body's own component
    // (else it dangles at the document root). See build-document `cleanNode` self-ref rewrite.
    interface Node {
      name: string;
      children: Node[];
    }
    const Category: z.ZodType<Node> = z.object({
      name: z.string(),
      children: z.array(z.lazy(() => Category)),
    });
    const frag = conv.toJsonSchema(Category as never) as {
      properties: { children: { items: unknown } };
    };
    expect(frag.properties.children.items).toEqual({ $ref: "#" });
  });

  it("a reused schema lands in $defs and both sites reference it", () => {
    // reused:'ref' → a single `$defs` entry; the builder relocates `$defs` → `components/schemas`
    // (AD-8 dedup). The generated ref name is zod's `__schema0`.
    const inner = z.object({ x: z.number() });
    const frag = conv.toJsonSchema(
      z.object({ a: inner, b: inner }) as never
    ) as {
      properties: { a: unknown; b: unknown };
      $defs: Record<string, unknown>;
    };
    expect(frag.properties.a).toEqual({ $ref: "#/$defs/__schema0" });
    expect(frag.properties.b).toEqual({ $ref: "#/$defs/__schema0" });
    expect(Object.keys(frag.$defs)).toEqual(["__schema0"]);
  });

  it("a discriminated union emits anyOf per branch, no discriminator", () => {
    // Raw zod emits `anyOf` with NO `discriminator`; the builder maps it to `oneOf` +
    // `discriminator.propertyName` (AD-8). If zod started emitting `oneOf`/discriminator itself, the
    // builder's rewrite would double up — lock the raw `anyOf` shape.
    const du = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), x: z.number() }),
      z.object({ kind: z.literal("b"), y: z.string() }),
    ]);
    const frag = conv.toJsonSchema(du as never) as {
      anyOf?: unknown[];
      oneOf?: unknown;
      discriminator?: unknown;
    };
    expect(Array.isArray(frag.anyOf)).toBe(true);
    expect(frag.anyOf).toHaveLength(2);
    expect(frag.oneOf).toBeUndefined();
    expect(frag.discriminator).toBeUndefined();
  });

  it("maps unrepresentable Date and bigint through the adapter override (FR-C5)", () => {
    // Date → string/date-time, bigint → string — the adapter's `applyTypePolicy`, not raw zod.
    expect(conv.toJsonSchema(z.date() as never)).toEqual({
      $schema: DIALECT,
      type: "string",
      format: "date-time",
    });
    expect(conv.toJsonSchema(z.bigint() as never)).toEqual({
      $schema: DIALECT,
      type: "string",
    });
  });
});
