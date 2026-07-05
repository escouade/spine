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

export interface OpenApiComponents {
  schemas?: { [name: string]: JsonSchemaObject };
  securitySchemes?: { [name: string]: JsonSchemaObject };
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
