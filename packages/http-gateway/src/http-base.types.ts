import type { Context as HonoCtx } from "hono";
import type { GatewayContext } from "@spinejs/gateway-core";

/** HTTP method + path pair used as the transport address for a route. */
export interface HttpAddress {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
}

/** The HTTP verbs the transport supports (the `method` half of an `HttpAddress`). */
export type HttpMethod = HttpAddress["method"];

/**
 * Transport-level context — app-agnostic. The generic `HttpGateway` only knows the Hono context;
 * any app concern (session, user) is added by an app-provided `ContextFactory`.
 */
export interface HttpBaseContext extends GatewayContext {
  honoCtx: HonoCtx;
}

/** Raw call data handed to the `ContextFactory`: the Hono request context. */
export type HttpRaw = HonoCtx;
