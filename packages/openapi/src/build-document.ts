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
  const meta = route.meta as HttpRouteMeta;
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

  const parameters = buildParameters(meta, converter);
  if (parameters.length > 0) op.parameters = parameters;

  if (meta.inputs.body) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: converter.toJsonSchema(meta.inputs.body, { io: "input" }),
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
 * Decompose the `params`/`query` object schemas into individual OpenAPI parameter objects: one per
 * property of the converted object fragment. Path params are always `required`; query params are
 * required iff the property is in the fragment's `required` list.
 */
function buildParameters(
  meta: HttpRouteMeta,
  converter: SchemaConverter
): JsonValue[] {
  const parameters: JsonValue[] = [];
  if (meta.inputs.params) {
    const fragment = converter.toJsonSchema(meta.inputs.params, {
      io: "input",
    });
    parameters.push(...decomposeParameters(fragment, "path"));
  }
  if (meta.inputs.query) {
    const fragment = converter.toJsonSchema(meta.inputs.query, { io: "input" });
    parameters.push(...decomposeParameters(fragment, "query"));
  }
  return parameters;
}

function decomposeParameters(
  fragment: JsonSchemaObject,
  location: "path" | "query"
): JsonValue[] {
  const properties = (fragment.properties ?? {}) as {
    [name: string]: JsonValue;
  };
  const required = Array.isArray(fragment.required)
    ? (fragment.required as string[])
    : [];
  // Path params keep property (declaration) order; query params are sorted for determinism (AD-6).
  const names =
    location === "path"
      ? Object.keys(properties)
      : Object.keys(properties).sort();

  return names.map((name) => ({
    name,
    in: location,
    required: location === "path" ? true : required.includes(name),
    schema: properties[name],
  }));
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

function pascalCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
