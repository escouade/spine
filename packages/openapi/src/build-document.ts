import type {
  JsonSchemaObject,
  JsonValue,
  ParseableSchema,
  SchemaConverter,
} from "@spinejs/gateway-core";
import type {
  HttpMethod,
  HttpRoute,
  HttpRouteMeta,
  RouteResponseDoc,
} from "@spinejs/http-gateway";
import { ComponentRegistry } from "./component-registry";
import { ZodSchemaConverter } from "./zod-schema-converter";
import type {
  OpenApiDocument,
  OpenApiInfo,
  OpenApiSecurity,
  OpenApiServer,
  SecuritySchemeObject,
} from "./types";

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
 * body schemas are registered as `components/schemas` and referenced with `$ref` (AD-8). Responses are
 * envelope-wrapped `{ ok, data }` / `{ ok, code }` components with a multi-status map (AD-7); SSE routes
 * are un-enveloped `text/event-stream` GETs (AD-15). Guard-derived security is Story 1.7.
 */
export function buildOpenApiDocument(
  routes: readonly HttpRoute[],
  config: BuildDocumentConfig,
  converter: SchemaConverter = new ZodSchemaConverter()
): OpenApiDocument {
  const excluded = new Set(config.exclude ?? []);
  const registry = new ComponentRegistry();
  // Guard-derived security schemes, accumulated across every operation (AD-9), emitted sorted (AD-6).
  const securitySchemes = new Map<string, SecuritySchemeObject>();

  // Group surviving routes by OpenAPI path → method. First registration of a {method, path} wins
  // (duplicate registration is an author error; full dedup policy is AD-8, Story 1.4).
  const byPath = new Map<string, Map<HttpMethod, HttpRoute>>();
  for (const route of routes) {
    const meta = route.meta as HttpRouteMeta | undefined;
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
          registry,
          securitySchemes
        );
      }
    }
    paths[openApiPath] = pathItem;
  }

  const schemas = registry.toSchemas();
  const secSchemes = sortedSecuritySchemes(securitySchemes);
  const components =
    schemas !== undefined || secSchemes !== undefined
      ? {
          ...(schemas && { schemas }),
          ...(secSchemes && { securitySchemes: secSchemes }),
        }
      : undefined;
  return {
    openapi: "3.1.0",
    info: config.info,
    ...(config.servers && { servers: config.servers }),
    paths,
    ...(components && { components }),
  };
}

/** The accumulated security schemes in sorted key order (AD-6), or `undefined` when none were declared. */
function sortedSecuritySchemes(
  securitySchemes: Map<string, SecuritySchemeObject>
): { [name: string]: SecuritySchemeObject } | undefined {
  if (securitySchemes.size === 0) return undefined;
  const sorted: { [name: string]: SecuritySchemeObject } = {};
  for (const name of [...securitySchemes.keys()].sort()) {
    sorted[name] = securitySchemes.get(name) as SecuritySchemeObject;
  }
  return sorted;
}

/** Build a single OpenAPI operation object from a route's address + meta. */
function buildOperation(
  route: HttpRoute,
  converter: SchemaConverter,
  registry: ComponentRegistry,
  securitySchemes: Map<string, SecuritySchemeObject>
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

  // Guard-derived security (AD-9) — read before the sse/body branch so SSE ops with guards get it too.
  const security = buildSecurity(route, securitySchemes);
  if (security !== undefined) op.security = security;

  if (meta.sse) {
    // SSE routes are un-enveloped event streams (AD-15): a GET with a `text/event-stream` success
    // response, no request body, no `{ ok, data }` envelope. Params/query still map above.
    op.responses = buildSseResponse(meta);
    return op;
  }

  if (inputs.body) {
    const ref = registerSchemaComponent(
      converter.toJsonSchema(inputs.body, { io: "input" }),
      registry,
      `${pascalCase(operationId)}_Body`
    );
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: { $ref: ref } } },
    };
  }

  op.responses = buildResponses(meta, converter, registry, operationId);

  return op;
}

/**
 * Derive an operation's `security` from its guards (AD-9). Each guard's concrete class may carry a
 * `static openapiSecurity = { name, scheme }`; the builder registers each `scheme` under `name` in the
 * shared `securitySchemes` map (a second guard claiming the same `name` with a **different** scheme is a
 * fail-fast build error) and returns a single requirement object listing every declared name (sorted,
 * empty scopes) — all of a route's guards must pass (AND). Guards without the static contribute nothing.
 */
function buildSecurity(
  route: HttpRoute,
  securitySchemes: Map<string, SecuritySchemeObject>
): JsonValue | undefined {
  const names: string[] = [];
  for (const guard of route.guards) {
    const declared = (
      guard.constructor as unknown as { openapiSecurity?: OpenApiSecurity }
    ).openapiSecurity;
    if (declared === undefined) continue; // a guard without the static contributes no scheme (AD-9)
    const { name, scheme } = declared;
    const existing = securitySchemes.get(name);
    if (existing !== undefined && !schemesEqual(existing, scheme)) {
      throw new Error(
        `OpenAPI: two guards declare security scheme "${name}" with different definitions.`
      );
    }
    securitySchemes.set(name, scheme);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return undefined;
  const requirement: { [name: string]: JsonValue } = {};
  for (const name of names.sort()) requirement[name] = [];
  return [requirement];
}

/**
 * Structural equality for two security schemes, **order-insensitive**: two guards declaring the same
 * scheme with its properties in a different literal order must dedup, not raise a false conflict.
 */
function schemesEqual(
  a: SecuritySchemeObject,
  b: SecuritySchemeObject
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Canonical JSON for a value: object keys sorted recursively, so key order never affects equality. */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as { [key: string]: JsonValue };
    const body = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the responses for an SSE route (AD-15): a single `200` whose body is `text/event-stream` (never
 * `application/json`, never envelope-wrapped). Static `headers` are declared like any success response.
 */
function buildSseResponse(meta: HttpRouteMeta): JsonValue {
  const response: { [key: string]: JsonValue } = {
    description: "Server-sent event stream",
  };
  if (meta.headers !== undefined)
    response.headers = buildResponseHeaders(meta.headers);
  response.content = { "text/event-stream": { schema: { type: "string" } } };
  return { "200": response };
}

/**
 * Relocate a converted fragment's `$defs`, register the cleaned root as a component, and resolve a
 * recursive `$ref: "#"` to that component. Shared by the request body and every response body.
 */
function registerSchemaComponent(
  converted: JsonSchemaObject,
  registry: ComponentRegistry,
  base: string
): string {
  const { root, authoredId } = relocateDefs(converted, registry, base);
  const ref = registry.register(root, { authoredId, derivedBase: base });
  // A recursive schema carries a `$ref: "#"` self-reference; now that the component name is known,
  // rewrite it to this component so it points at itself instead of dangling at the document root.
  registry.overwrite(ref, finalizeComponent(root, new Map(), ref));
  return ref;
}

/**
 * Build the `responses` object (AD-7). The success status carries a synthesized envelope component
 * `{ ok: true, data: $ref }` (data-less `{ ok: true }` when the route has no `response` schema); each
 * `responses`-map entry adds an envelope-wrapped success (its `schema`) or the shared `{ ok: false,
 * code }` error component. Static `headers` declare success-response headers, author `examples` sit on
 * the success media type. Statuses emit in ascending numeric order (AD-6); the success entry wins its
 * own status if a `responses` key collides with `successStatus`.
 */
function buildResponses(
  meta: HttpRouteMeta,
  converter: SchemaConverter,
  registry: ComponentRegistry,
  operationId: string
): JsonValue {
  const successStatus = meta.successStatus ?? 200;
  const byStatus = new Map<number, JsonValue>();
  byStatus.set(
    successStatus,
    buildSuccessResponse(meta, converter, registry, operationId)
  );

  const extra = meta.responses ?? {};
  for (const key of Object.keys(extra)) {
    const status = Number(key);
    if (byStatus.has(status)) continue; // the success entry wins its own status
    byStatus.set(
      status,
      buildExtraResponse(
        status,
        extra[status],
        converter,
        registry,
        operationId
      )
    );
  }

  const responses: { [status: string]: JsonValue } = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    responses[String(status)] = byStatus.get(status) as JsonValue;
  }
  return responses;
}

/** The success response: envelope `$ref` at `successStatus`, plus declared `headers` and `examples`. */
function buildSuccessResponse(
  meta: HttpRouteMeta,
  converter: SchemaConverter,
  registry: ComponentRegistry,
  operationId: string
): JsonValue {
  const pascal = pascalCase(operationId);
  const envelopeRef = registerSuccessEnvelope(
    meta.response,
    converter,
    registry,
    `${pascal}_Response`,
    `${pascal}_ResponseEnvelope`
  );
  const media: { [key: string]: JsonValue } = { schema: { $ref: envelopeRef } };
  // Author-supplied OpenAPI Example objects — opaque JSON, surfaced verbatim at the media-type level.
  if (meta.examples !== undefined) media.examples = meta.examples as JsonValue;

  const response: { [key: string]: JsonValue } = { description: "OK" };
  if (meta.headers !== undefined)
    response.headers = buildResponseHeaders(meta.headers);
  response.content = { "application/json": media };
  return response;
}

/** An extra documented status: envelope-wrapped success (has `schema`), shared error (has `code`), or bare. */
function buildExtraResponse(
  status: number,
  doc: RouteResponseDoc,
  converter: SchemaConverter,
  registry: ComponentRegistry,
  operationId: string
): JsonValue {
  const pascal = pascalCase(operationId);
  if (doc.schema !== undefined) {
    const envelopeRef = registerSuccessEnvelope(
      doc.schema,
      converter,
      registry,
      `${pascal}_Response${status}`,
      `${pascal}_ResponseEnvelope${status}`
    );
    return {
      description: doc.description ?? "OK",
      content: { "application/json": { schema: { $ref: envelopeRef } } },
    };
  }
  if (doc.code !== undefined) {
    const errorRef = registry.register(errorEnvelope(), {
      derivedBase: "ErrorResponse",
    });
    return {
      // The concrete code stays documentation (the shared component keeps a generic `code: string`).
      description: doc.description ?? `Error (${doc.code})`,
      content: { "application/json": { schema: { $ref: errorRef } } },
    };
  }
  return { description: doc.description ?? "" };
}

/**
 * Register a `{ ok: true, data: $ref }` success envelope (data-less `{ ok: true }` when no schema) and
 * return its ref. The inner schema is converted `io: "output"` (FR-C6) and registered as its own component.
 */
function registerSuccessEnvelope(
  responseSchema: ParseableSchema<unknown> | undefined,
  converter: SchemaConverter,
  registry: ComponentRegistry,
  innerBase: string,
  envelopeBase: string
): string {
  const properties: { [key: string]: JsonValue } = { ok: { const: true } };
  const required: JsonValue[] = ["ok"];
  if (responseSchema !== undefined) {
    const innerRef = registerSchemaComponent(
      converter.toJsonSchema(responseSchema, { io: "output" }),
      registry,
      innerBase
    );
    properties.data = { $ref: innerRef };
    required.push("data");
  }
  const envelope: JsonSchemaObject = { type: "object", properties, required };
  return registry.register(envelope, { derivedBase: envelopeBase });
}

/**
 * The shared error envelope `{ ok: false, code: string, meta? }` — content-identical, so it dedups to
 * one component. `meta` mirrors gateway-core's optional `FailureMeta` (semantic rejection context,
 * e.g. `retryAfterMs` for rate limiting): optional and open-ended, so the addition stays additive.
 */
function errorEnvelope(): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      ok: { const: false },
      code: { type: "string" },
      meta: {
        type: "object",
        properties: { retryAfterMs: { type: "number" } },
      },
    },
    required: ["ok", "code"],
  };
}

/** Declared response headers: each static value captured as a `const` schema (sorted for AD-6). */
function buildResponseHeaders(headers: Record<string, string>): JsonValue {
  const out: { [name: string]: JsonValue } = {};
  for (const name of Object.keys(headers).sort()) {
    out[name] = { schema: { const: headers[name] } };
  }
  return out;
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

  // Pass 1: register each raw $defs entry to lock its final component name, and build the ref map from
  // the names the registry *actually* assigned. A collision that suffixes `Foo` to `Foo_2` therefore
  // updates the map too — the pass never leaves a `$ref` pointing at a name that was suffixed away.
  const refMap = new Map<string, string>();
  const entryRefs: { key: string; ref: string }[] = [];
  for (const key of keys) {
    const entry = defs[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const authoredId =
      typeof (entry as JsonSchemaObject).id === "string"
        ? ((entry as JsonSchemaObject).id as string)
        : undefined;
    const ref = registry.register(entry as JsonSchemaObject, {
      authoredId,
      derivedBase: `${base}_${pascalCase(key)}`,
    });
    refMap.set(key, ref);
    entryRefs.push({ key, ref });
  }

  // Pass 2: overwrite each locked component with its cleaned body. The complete map is known now, so
  // inter-entry refs resolve; `selfRef` resolves a `$ref: "#"` (a recursive $defs entry) to itself.
  for (const { key, ref } of entryRefs) {
    registry.overwrite(
      ref,
      finalizeComponent(defs[key] as JsonSchemaObject, refMap, ref)
    );
  }

  const authoredId =
    typeof fragment.id === "string" ? (fragment.id as string) : undefined;
  return { root: finalizeComponent(fragment, refMap), authoredId };
}

/** Strip a fragment's top-level dialect/meta keys (`$schema`, `$defs`, leaked `id`) and clean the body. */
function finalizeComponent(
  fragment: JsonSchemaObject,
  refMap: Map<string, string>,
  selfRef?: string
): JsonSchemaObject {
  const clone: { [key: string]: JsonValue } = { ...fragment };
  delete clone.$schema;
  delete clone.$defs;
  delete clone.id;
  return cleanNode(clone, refMap, selfRef) as JsonSchemaObject;
}

/**
 * Recursively rewrite a schema node: `#/$defs/<key>` `$ref` → `#/components/schemas/<name>` (via the ref
 * map); a `$ref: "#"` (zod's `cycles: "ref"` self-reference) → `selfRef`, this fragment's own component
 * (else it would dangle at the document root); and a discriminated union (`anyOf` whose members share a
 * `const`-valued property) → `oneOf` + `discriminator.propertyName`. A plain `anyOf` (e.g. nullable) is
 * left as-is. No keys are stripped here — a schema property literally named `id`/`$defs` is left
 * untouched (only the top level is cleaned).
 */
function cleanNode(
  value: JsonValue,
  refMap: Map<string, string>,
  selfRef?: string
): JsonValue {
  if (Array.isArray(value))
    return value.map((item) => cleanNode(item, refMap, selfRef));
  if (value !== null && typeof value === "object") {
    const obj = value as { [key: string]: JsonValue };

    const ref = obj.$ref;
    if (
      typeof ref === "string" &&
      (ref.startsWith("#/$defs/") || ref === "#")
    ) {
      const mapped =
        ref === "#" ? selfRef : refMap.get(ref.slice("#/$defs/".length));
      const out: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(obj)) {
        out[key] =
          key === "$ref" && mapped !== undefined
            ? mapped
            : cleanNode(item, refMap, selfRef);
      }
      return out;
    }

    if (Array.isArray(obj.anyOf)) {
      const propertyName = findDiscriminator(obj.anyOf);
      if (propertyName !== undefined) {
        const out: { [key: string]: JsonValue } = {};
        for (const [key, item] of Object.entries(obj)) {
          if (key === "anyOf") continue;
          out[key] = cleanNode(item, refMap, selfRef);
        }
        out.oneOf = obj.anyOf.map((member) =>
          cleanNode(member, refMap, selfRef)
        );
        out.discriminator = { propertyName };
        return out;
      }
    }

    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(obj)) {
      out[key] = cleanNode(item, refMap, selfRef);
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
