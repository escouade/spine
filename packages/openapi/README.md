# @spinejs/openapi

Automatic **OpenAPI 3.1** generation from your SpineJS HTTP route markers — the
zod schemas you already write become the API contract, with zero extra
declaration. Ships a self-hosted Swagger UI and a headless file emitter too.

> Early access: the package is being built battery-by-battery. This release
> provides the schema-conversion adapter; the document builder, live serving,
> and CLI land in the following stories.

## Convert a zod schema to a JSON Schema fragment

`ZodSchemaConverter` implements the framework's `SchemaConverter` port. It turns
a zod schema into an OpenAPI-3.1 (draft-2020-12) JSON Schema fragment.

```ts
import { z } from "zod/v4";
import { ZodSchemaConverter } from "@spinejs/openapi";

const converter = new ZodSchemaConverter();

const User = z.object({ id: z.string(), createdAt: z.date() });

converter.toJsonSchema(User, { io: "output" });
// {
//   $schema: "https://json-schema.org/draft/2020-12/schema",
//   type: "object",
//   properties: { id: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
//   required: ["id", "createdAt"],
//   additionalProperties: false,
// }
```

Schemas **must** be authored with the `zod/v4` surface (the one that carries
`z.toJSONSchema`). A classic `zod` (v3) schema is rejected — see _Reference_.

## Reference

### `class ZodSchemaConverter implements SchemaConverter`

`toJsonSchema(schema, opts?: { io?: "input" | "output" }): JsonSchemaObject`

- `io: "input"` projects the request side of a transform (e.g. a field with a
  default is optional); `io: "output"` projects the response side (the field is
  required). Omitted → zod's default (`"output"`).
- `Date` → `{ type: "string", format: "date-time" }`, `bigint` →
  `{ type: "string" }`; any other unrepresentable type → open schema `{}`,
  logged once.
- Reused schemas are hoisted to `$defs` and referenced with `$ref`. Relocating
  them to `components/schemas` is the document builder's job, not the adapter's.

`zod` is pinned exact (`3.25.76`) because `z.toJSONSchema` output is
version-sensitive.
