import type {
  JsonSchemaObject,
  JsonValue,
  SchemaConverter,
} from "@spinejs/gateway-core";
import type {
  HttpMethod,
  HttpRoute,
  HttpRouteMeta,
} from "@spinejs/http-gateway";
import { ZodSchemaConverter } from "./zod-schema-converter";
import type { OpenApiDocument, OpenApiInfo, OpenApiServer } from "./types";

/** Configuration the pure builder needs. The full `OpenApiModule.configure` surface is Story 3.1. */
export interface BuildDocumentConfig {
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  /** Route paths (spine `:param` syntax) excluded from the document — see also per-route `hidden`. */
  exclude?: string[];
}

/** OpenAPI operation key order within a path item (AD-6 determinism). */
const VERB_ORDER: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

/**
 * Build an OpenAPI 3.1 document from the HTTP routes read off `HttpGateway.routes` (AD-4).
 *
 * Pure and deterministic (AD-5/AD-6): no I/O, no listener; same routes + config → identical output
 * (paths sorted lexically, operations in `VERB_ORDER`). Schemas are converted through the injected
 * {@link SchemaConverter} port (defaults to the zod adapter) and emitted **inline** — relocating them
 * to `components/schemas` is Story 1.4. Response bodies are a minimal placeholder here; the
 * `{ ok, data }` envelope + multi-status map are Story 1.5. SSE routes are skipped (Story 1.6) and
 * guard-derived security is Story 1.7.
 */
export function buildOpenApiDocument(
  routes: readonly HttpRoute[],
  config: BuildDocumentConfig,
  converter: SchemaConverter = new ZodSchemaConverter()
): OpenApiDocument {
  const excluded = new Set(config.exclude ?? []);

  // Group surviving routes by OpenAPI path → method. First registration of a {method, path} wins
  // (duplicate registration is an author error; full dedup policy is AD-8, Story 1.4).
  const byPath = new Map<string, Map<HttpMethod, HttpRoute>>();
  for (const route of routes) {
    const meta = route.meta as HttpRouteMeta | undefined;
    if (meta?.sse) continue; // SSE → Story 1.6
    if (meta?.hidden) continue; // hidden route (AD-13)
    if (excluded.has(route.address.path)) continue; // module exclude list (AD-13)

    const openApiPath = toOpenApiPath(route.address.path);
    let methods = byPath.get(openApiPath);
    if (!methods) {
      methods = new Map();
      byPath.set(openApiPath, methods);
    }
    if (!methods.has(route.address.method)) {
      methods.set(route.address.method, route);
    }
  }

  const paths: { [path: string]: JsonValue } = {};
  for (const openApiPath of [...byPath.keys()].sort()) {
    const methods = byPath.get(openApiPath) as Map<HttpMethod, HttpRoute>;
    const pathItem: { [method: string]: JsonValue } = {};
    for (const method of VERB_ORDER) {
      const route = methods.get(method);
      if (route)
        pathItem[method.toLowerCase()] = buildOperation(route, converter);
    }
    paths[openApiPath] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: config.info,
    ...(config.servers && { servers: config.servers }),
    paths,
  };
}

/** Build a single OpenAPI operation object from a route's address + meta. */
function buildOperation(
  route: HttpRoute,
  converter: SchemaConverter
): JsonValue {
  const meta = (route.meta ?? {}) as HttpRouteMeta;
  const inputs = meta.inputs ?? {};
  const { method, path } = route.address;
  const op: { [key: string]: JsonValue } = {};

  // Doc metadata (RouteDocMeta) — only valid Operation-Object fields, only when present.
  // `examples` is intentionally NOT emitted here: it is not a valid Operation field in OpenAPI 3.1
  // (examples live in the response media type), so it is carried to Story 1.5 instead.
  if (meta.summary !== undefined) op.summary = meta.summary;
  if (meta.description !== undefined) op.description = meta.description;
  if (meta.tags !== undefined) op.tags = meta.tags;
  op.operationId = meta.operationId ?? deriveOperationId(method, path);
  if (meta.deprecated !== undefined) op.deprecated = meta.deprecated;

  const parameters = buildParameters(path, inputs, converter);
  if (parameters.length > 0) op.parameters = parameters;

  if (inputs.body) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: sanitizeFragment(
            converter.toJsonSchema(inputs.body, { io: "input" })
          ),
        },
      },
    };
  }

  // Minimal placeholder — the envelope-wrapped body + multi-status map are Story 1.5.
  op.responses = {
    [String(meta.successStatus ?? 200)]: { description: "OK" },
  };

  return op;
}

/**
 * Build the operation's parameters. **Path** parameters are driven by the path template tokens (every
 * `{param}` must be declared as `required`), taking the property schema from `params` when present and
 * defaulting to `string` otherwise — so a `:param` route is never emitted with an undeclared path
 * variable, even when the author supplies no `params` schema. **Query** parameters are decomposed from
 * the `query` object schema, required iff the property is in the fragment's `required` list.
 */
function buildParameters(
  path: string,
  inputs: HttpRouteMeta["inputs"],
  converter: SchemaConverter
): JsonValue[] {
  const parameters: JsonValue[] = [];

  const paramProps = inputs.params
    ? ((sanitizeFragment(converter.toJsonSchema(inputs.params, { io: "input" }))
        .properties ?? {}) as { [name: string]: JsonValue })
    : {};
  for (const name of pathTemplateParams(path)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: paramProps[name] ?? { type: "string" },
    });
  }

  if (inputs.query) {
    const fragment = sanitizeFragment(
      converter.toJsonSchema(inputs.query, { io: "input" })
    );
    parameters.push(...decomposeQueryParameters(fragment));
  }

  return parameters;
}

/** Decompose a `query` object fragment into one query parameter per property (sorted for AD-6). */
function decomposeQueryParameters(fragment: JsonSchemaObject): JsonValue[] {
  const properties = (fragment.properties ?? {}) as {
    [name: string]: JsonValue;
  };
  const required = Array.isArray(fragment.required)
    ? (fragment.required as string[])
    : [];
  return Object.keys(properties)
    .sort()
    .map((name) => ({
      name,
      in: "query",
      required: required.includes(name),
      schema: properties[name],
    }));
}

/** Path template variables, in declaration order, from a spine `:param` path. */
function pathTemplateParams(path: string): string[] {
  const names: string[] = [];
  const pattern = /:([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) names.push(match[1]);
  return names;
}

/**
 * Make a converter fragment self-contained and OpenAPI-safe before it is emitted inline: strip the
 * `$schema` dialect marker (the converter's contract assigns stripping to the builder) and inline any
 * local `#/$defs/*` `$ref` (the reused-schema strategy — relocating them to `components/schemas` is
 * Story 1.4). A cyclic `$defs` is kept in place (valid draft-2020-12) so no `$ref` ever dangles.
 */
function sanitizeFragment(fragment: JsonSchemaObject): JsonSchemaObject {
  const rawDefs = fragment.$defs;
  const defs =
    rawDefs !== null && typeof rawDefs === "object" && !Array.isArray(rawDefs)
      ? (rawDefs as { [name: string]: JsonValue })
      : {};
  let cyclic = false;

  const resolve = (value: JsonValue, stack: Set<string>): JsonValue => {
    if (Array.isArray(value)) return value.map((item) => resolve(item, stack));
    if (value !== null && typeof value === "object") {
      const ref = (value as { [key: string]: JsonValue }).$ref;
      if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
        const name = ref.slice("#/$defs/".length);
        if (stack.has(name)) {
          cyclic = true;
          return value;
        }
        const target = defs[name];
        if (target === undefined) return value;
        return resolve(target, new Set(stack).add(name));
      }
      const out: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "$schema" || key === "$defs") continue;
        out[key] = resolve(item, stack);
      }
      return out;
    }
    return value;
  };

  const resolved = resolve(fragment, new Set()) as JsonSchemaObject;
  if (cyclic) resolved.$defs = defs;
  return resolved;
}

/** Convert a spine (Hono) path `/things/:id` to an OpenAPI path `/things/{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Deterministically derive an `operationId` from method + path when the author gave none:
 * lowercase verb + PascalCased static segments, path params folded as `By<Param>`.
 * e.g. `GET /users` → `getUsers`, `GET /users/:id` → `getUsersById`.
 */
function deriveOperationId(method: HttpMethod, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(":")
        ? "By" + pascalCase(segment.slice(1))
        : pascalCase(segment)
    );
  return method.toLowerCase() + segments.join("");
}

/** PascalCase a path segment, dropping non-alphanumerics so the operationId stays a clean identifier. */
function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}
