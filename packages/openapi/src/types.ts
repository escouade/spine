import type { JsonSchemaObject, JsonValue } from "@spinejs/gateway-core";

/**
 * JSON-safe OpenAPI 3.1 document types — the `@spinejs/openapi` pendant of
 * `gateway-core`'s {@link JsonSchemaObject} (AD-14). Intentionally lean: this is
 * the shared seam the document builder (later stories) populates and refines.
 * Path-item / operation detail is left as `JsonValue` for now; only the
 * top-level document shape is fixed here.
 */

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiTag {
  name: string;
  description?: string;
}

/**
 * A JSON-safe OpenAPI 3.1 Security Scheme Object (e.g. `{ type: "http", scheme: "bearer" }`) — an
 * OpenAPI object, NOT a JSON Schema, so it stays a plain JSON-safe record (AD-14).
 */
export type SecuritySchemeObject = { [key: string]: JsonValue };

/**
 * A guard's self-declared security (AD-9): the scheme `name` (its `components.securitySchemes` key and
 * per-operation `security` requirement) and its {@link SecuritySchemeObject}. A guard class carries this
 * as `static openapiSecurity: OpenApiSecurity`; the builder reads it off each route's guard instances.
 */
export interface OpenApiSecurity {
  name: string;
  scheme: SecuritySchemeObject;
}

export interface OpenApiComponents {
  schemas?: { [name: string]: JsonSchemaObject };
  /** Security-scheme objects, keyed by name — derived from guards (AD-9), never a JSON Schema. */
  securitySchemes?: { [name: string]: SecuritySchemeObject };
}

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  /** Path → path-item object. Typed loosely until the builder refines it. */
  paths: { [path: string]: JsonValue };
  components?: OpenApiComponents;
  tags?: OpenApiTag[];
  security?: Array<{ [scheme: string]: string[] }>;
}
