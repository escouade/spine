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

/**
 * Per-request **response-headers bag** ctx symbol (AD-8 — owned by http-gateway, the package that
 * owns response construction). Any producer running during dispatch (an interceptor, a battery
 * preset) may write plain header name → value pairs into `ctx[responseHeadersBag]`; `bind()` merges
 * them into the response on BOTH the success and the error path, in order
 * **gateway defaults < bag < route `meta.headers`**. http-gateway only merges — it never writes.
 *
 * Requests that never touch the bag produce byte-identical responses to before the seam.
 *
 * SSE dispatch sites (`dispatchSse` deny path and stream-open) are explicitly OUT of scope here and
 * do not merge the bag yet — they land with the SSE connect-enforcement seam (Epic 2, AD-6).
 */
export const responseHeadersBag = Symbol("spine.http.responseHeadersBag");

/** Shape of the {@link responseHeadersBag} slot on a ctx: plain header name → value pairs. */
export type ResponseHeadersBag = Record<string, string>;

/** Reads the bag a producer left on the ctx, if any (http-gateway's merge-side accessor). */
export function readResponseHeadersBag(
  ctx: GatewayContext
): ResponseHeadersBag | undefined {
  return (ctx as { [responseHeadersBag]?: ResponseHeadersBag })[
    responseHeadersBag
  ];
}

/**
 * Returns the ctx's headers bag, creating it on first access — the producer-side accessor
 * (e.g. the throttle `./http` preset translating a quota outcome into `RateLimit-*` headers).
 */
export function responseHeadersOf(ctx: GatewayContext): ResponseHeadersBag {
  const slot = ctx as { [responseHeadersBag]?: ResponseHeadersBag };
  return (slot[responseHeadersBag] ??= {});
}
