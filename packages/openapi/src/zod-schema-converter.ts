import { z } from "zod/v4";
import type {
  JsonSchemaObject,
  ParseableSchema,
  SchemaConverter,
} from "@spinejs/gateway-core";

/** Options for {@link ZodSchemaConverter}. */
export interface ZodSchemaConverterOptions {
  /**
   * Sink for the one-time "unrepresentable type → open schema `{}`" notice
   * (FR-C5). Defaults to `console.warn`. Injectable so it can be silenced or
   * captured in tests.
   */
  warn?: (message: string) => void;
}

/**
 * zod-backed {@link SchemaConverter} adapter. Carries the zod dependency so
 * `gateway-core` stays dep-free — exactly like `ZodValidator` mirrors the
 * `Validator` port.
 *
 * Emits an **OpenAPI 3.1** (draft-2020-12) JSON Schema *fragment* via zod v4's
 * native `z.toJSONSchema`. Deliberately faithful: the fragment is returned as
 * produced (it may carry `$schema`, `$defs`, native `anyOf` for unions, etc.).
 * Assembling those fragments into one document — relocating `$defs` to
 * `components/schemas`, the `oneOf`+discriminator rewrite, stripping `$schema` —
 * is the document builder's job, not this adapter's.
 *
 * Schemas must be authored with the `zod/v4` surface (the one exposing
 * `z.toJSONSchema`); a classic zod-v3 schema throws inside the converter. The
 * port stays open for a future v3 adapter (not shipped in v1).
 */
export class ZodSchemaConverter implements SchemaConverter {
  private readonly warn: (message: string) => void;
  private readonly loggedUnrepresentable = new Set<string>();

  constructor(options: ZodSchemaConverterOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * Convert a schema to an OpenAPI-3.1 (draft-2020-12) JSON Schema fragment.
   *
   * `opts.io` picks the projection of a transform-bearing schema: `"input"` for
   * request bodies/params, `"output"` for responses (FR-C6). **Omitted →
   * `"output"`** (zod's default) — a caller documenting a *request* must pass
   * `io: "input"` explicitly, otherwise defaulted fields project as required.
   */
  toJsonSchema(
    schema: ParseableSchema<unknown>,
    opts?: { io?: "input" | "output" }
  ): JsonSchemaObject {
    // The port hands a structural `ParseableSchema` (only `.parse` guaranteed);
    // the zod adapter narrows it to zod's own input type to reach `toJSONSchema`.
    const zodSchema = schema as unknown as Parameters<typeof z.toJSONSchema>[0];

    const json = z.toJSONSchema(zodSchema, {
      target: "draft-2020-12",
      io: opts?.io,
      reused: "ref",
      cycles: "ref",
      unrepresentable: "any",
      override: (ctx) => this.applyTypePolicy(ctx),
    });

    return json as JsonSchemaObject;
  }

  /**
   * FR-C5 unrepresentable-type policy, applied per node during conversion:
   * `Date` → `string`/`date-time`, `bigint` → `string`; any other type zod left
   * as an open schema `{}` (because of `unrepresentable: "any"`) is logged once.
   */
  private applyTypePolicy(ctx: {
    zodSchema: unknown;
    jsonSchema: Record<string, unknown>;
  }): void {
    // `_zod.def.type` is a zod internal — read it through a narrow local cast so
    // `typecheck` stays green without loosening the port or the ctx type.
    const type = (ctx.zodSchema as { _zod?: { def?: { type?: string } } })._zod
      ?.def?.type;
    const node = ctx.jsonSchema;

    if (type === "date") {
      node.type = "string";
      node.format = "date-time";
      return;
    }
    if (type === "bigint") {
      node.type = "string";
      return;
    }

    // `any`/`unknown` legitimately convert to an open schema `{}` — that IS their
    // correct JSON Schema, not a fallback — so they must not trip the warning
    // (also covers `z.record(k, z.unknown())`, a common idiom).
    if (type === "any" || type === "unknown") {
      return;
    }

    // Residual: zod emitted an open schema `{}` for a type it cannot represent.
    if (Object.keys(node).length === 0) {
      const key = type ?? "unknown";
      if (!this.loggedUnrepresentable.has(key)) {
        this.loggedUnrepresentable.add(key);
        this.warn(
          `[@spinejs/openapi] zod type "${key}" is not representable in JSON Schema; emitted an open schema {}.`
        );
      }
    }
  }
}
