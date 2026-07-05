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
import { ComponentRegistry } from "./component-registry";
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
 * (paths sorted lexically, operations in `VERB_ORDER`, components in sorted key order). Schemas are
 * converted through the injected {@link SchemaConverter} port (defaults to the zod adapter); reused and
 * body schemas are registered as `components/schemas` and referenced with `$ref` (AD-8). Response
 * bodies are a minimal placeholder here; the `{ ok, data }` envelope + multi-status map are Story 1.5.
 * SSE routes are skipped (Story 1.6) and guard-derived security is Story 1.7.
 */
export function buildOpenApiDocument(
  routes: readonly HttpRoute[],
  config: BuildDocumentConfig,
  converter: SchemaConverter = new ZodSchemaConverter()
): OpenApiDocument {
  const excluded = new Set(config.exclude ?? []);
  const registry = new ComponentRegistry();

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
      if (route) {
        pathItem[method.toLowerCase()] = buildOperation(
          route,
          converter,
          registry
        );
      }
    }
    paths[openApiPath] = pathItem;
  }

  const schemas = registry.toSchemas();
  return {
    openapi: "3.1.0",
    info: config.info,
    ...(config.servers && { servers: config.servers }),
    paths,
    ...(schemas && { components: { schemas } }),
  };
}

/** Build a single OpenAPI operation object from a route's address + meta. */
function buildOperation(
  route: HttpRoute,
  converter: SchemaConverter,
  registry: ComponentRegistry
): JsonValue {
  const meta = (route.meta ?? {}) as HttpRouteMeta;
  const inputs = meta.inputs ?? {};
  const { method, path } = route.address;
  const operationId = meta.operationId ?? deriveOperationId(method, path);
  const op: { [key: string]: JsonValue } = {};

  // Doc metadata (RouteDocMeta) — only valid Operation-Object fields, only when present.
  // `examples` is intentionally NOT emitted here: it is not a valid Operation field in OpenAPI 3.1
  // (examples live in the response media type), so it is carried to Story 1.5 instead.
  if (meta.summary !== undefined) op.summary = meta.summary;
  if (meta.description !== undefined) op.description = meta.description;
  if (meta.tags !== undefined) op.tags = meta.tags;
  op.operationId = operationId;
  if (meta.deprecated !== undefined) op.deprecated = meta.deprecated;

  const parameters = buildParameters(
    path,
    inputs,
    converter,
    registry,
    operationId
  );
  if (parameters.length > 0) op.parameters = parameters;

  if (inputs.body) {
    const base = `${pascalCase(operationId)}_Body`;
    const { root, authoredId } = relocateDefs(
      converter.toJsonSchema(inputs.body, { io: "input" }),
      registry,
      base
    );
    const ref = registry.register(root, { authoredId, derivedBase: base });
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: { $ref: ref } } },
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
 * defaulting to `string` otherwise. **Query** parameters are decomposed from the `query` object schema.
 * Property schemas stay **inline**, but each fragment's `$defs` are relocated to `components/schemas`
 * first, so a property referencing a reused schema emits a component `$ref` (never a dangling `#/$defs`).
 */
function buildParameters(
  path: string,
  inputs: HttpRouteMeta["inputs"],
  converter: SchemaConverter,
  registry: ComponentRegistry,
  operationId: string
): JsonValue[] {
  const parameters: JsonValue[] = [];

  const paramProps = inputs.params
    ? ((relocateDefs(
        converter.toJsonSchema(inputs.params, { io: "input" }),
        registry,
        `${pascalCase(operationId)}_Params`
      ).root.properties ?? {}) as { [name: string]: JsonValue })
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
    const { root } = relocateDefs(
      converter.toJsonSchema(inputs.query, { io: "input" }),
      registry,
      `${pascalCase(operationId)}_Query`
    );
    parameters.push(...decomposeQueryParameters(root));
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

/**
 * Relocate a converted fragment's `$defs` into the registry (AD-8) and return the cleaned root body:
 * every `$defs` entry becomes a `components/schemas` entry (its authored `.meta({ id })` name, else
 * `<base>_<key>`), and every `#/$defs/<key>` `$ref` is rewritten to `#/components/schemas/<name>`. The
 * `$schema` dialect marker and the leaked `.meta` `id` key are stripped; discriminated unions are
 * rewritten to `oneOf` + `discriminator`. `authoredId` is the root schema's own `.meta({ id })`, if any.
 */
function relocateDefs(
  fragment: JsonSchemaObject,
  registry: ComponentRegistry,
  base: string
): { root: JsonSchemaObject; authoredId?: string } {
  const rawDefs = fragment.$defs;
  const defs =
    rawDefs !== null && typeof rawDefs === "object" && !Array.isArray(rawDefs)
      ? (rawDefs as { [name: string]: JsonValue })
      : {};

  const keys = Object.keys(defs).sort();

  // Pass 1: assign a component name to every $defs key and build the ref map (so inter-entry and root
  // refs all resolve, regardless of order). Derived names include the key, unique within the fragment.
  const refMap = new Map<string, string>();
  const authoredById = new Map<string, string | undefined>();
  for (const key of keys) {
    const entry = defs[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const authoredId =
      typeof (entry as JsonSchemaObject).id === "string"
        ? ((entry as JsonSchemaObject).id as string)
        : undefined;
    const name = authoredId ?? `${base}_${pascalCase(key)}`;
    authoredById.set(key, authoredId);
    refMap.set(key, `#/components/schemas/${name}`);
  }

  // Pass 2: clean + register each entry with the complete ref map.
  for (const key of keys) {
    if (!refMap.has(key)) continue;
    const cleaned = finalizeComponent(defs[key] as JsonSchemaObject, refMap);
    registry.register(cleaned, {
      authoredId: authoredById.get(key),
      derivedBase: `${base}_${pascalCase(key)}`,
    });
  }

  const authoredId =
    typeof fragment.id === "string" ? (fragment.id as string) : undefined;
  return { root: finalizeComponent(fragment, refMap), authoredId };
}

/** Strip a fragment's top-level dialect/meta keys (`$schema`, `$defs`, leaked `id`) and clean the body. */
function finalizeComponent(
  fragment: JsonSchemaObject,
  refMap: Map<string, string>
): JsonSchemaObject {
  const clone: { [key: string]: JsonValue } = { ...fragment };
  delete clone.$schema;
  delete clone.$defs;
  delete clone.id;
  return cleanNode(clone, refMap) as JsonSchemaObject;
}

/**
 * Recursively rewrite a schema node: `#/$defs/<key>` `$ref` → `#/components/schemas/<name>` (via the ref
 * map), and a discriminated union (`anyOf` whose members share a `const`-valued property) → `oneOf` +
 * `discriminator.propertyName`. A plain `anyOf` (e.g. nullable) is left as-is. No keys are stripped here
 * — a schema property literally named `id`/`$defs` is left untouched (only the top level is cleaned).
 */
function cleanNode(value: JsonValue, refMap: Map<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cleanNode(item, refMap));
  if (value !== null && typeof value === "object") {
    const obj = value as { [key: string]: JsonValue };

    const ref = obj.$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
      const mapped = refMap.get(ref.slice("#/$defs/".length));
      const out: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(obj)) {
        out[key] =
          key === "$ref" && mapped !== undefined
            ? mapped
            : cleanNode(item, refMap);
      }
      return out;
    }

    if (Array.isArray(obj.anyOf)) {
      const propertyName = findDiscriminator(obj.anyOf);
      if (propertyName !== undefined) {
        const out: { [key: string]: JsonValue } = {};
        for (const [key, item] of Object.entries(obj)) {
          if (key === "anyOf") continue;
          out[key] = cleanNode(item, refMap);
        }
        out.oneOf = obj.anyOf.map((member) => cleanNode(member, refMap));
        out.discriminator = { propertyName };
        return out;
      }
    }

    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(obj)) {
      out[key] = cleanNode(item, refMap);
    }
    return out;
  }
  return value;
}

/**
 * The discriminator property of a union, or `undefined` when it is not a discriminated union: the
 * (lexically first, for determinism) property present in **every** member as a single-value `const`.
 */
function findDiscriminator(members: JsonValue[]): string | undefined {
  if (members.length === 0) return undefined;
  const memberProps: { [name: string]: JsonValue }[] = [];
  for (const member of members) {
    if (
      member === null ||
      typeof member !== "object" ||
      Array.isArray(member)
    ) {
      return undefined;
    }
    const props = (member as { [key: string]: JsonValue }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) {
      return undefined;
    }
    memberProps.push(props as { [name: string]: JsonValue });
  }
  for (const name of Object.keys(memberProps[0]).sort()) {
    const everyConst = memberProps.every((props) => {
      const prop = props[name];
      return (
        prop !== null &&
        typeof prop === "object" &&
        !Array.isArray(prop) &&
        "const" in (prop as { [key: string]: JsonValue })
      );
    });
    if (everyConst) return name;
  }
  return undefined;
}

/** Path template variables, in declaration order, from a spine `:param` path. */
function pathTemplateParams(path: string): string[] {
  const names: string[] = [];
  const pattern = /:([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) names.push(match[1]);
  return names;
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

/** PascalCase a token, dropping non-alphanumerics so derived identifiers stay clean. */
function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}
