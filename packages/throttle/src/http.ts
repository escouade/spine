// @spinejs/throttle/http — the HTTP preset (AD-1): the `'ip'` key source (socket address via
// `@hono/node-server`, `trustProxy` option, IPv4-mapped normalization before the IPv6 /56 mask) and
// the sole outcome→headers translator (draft-6 `RateLimit-*` + `Retry-After` through the AD-8
// response-headers bag). Optional peers: `@spinejs/http-gateway` + `@hono/node-server`.
// Key source + translator land with Story 1.9.
import type {} from "@spinejs/http-gateway";
import type { ThrottleRouteMeta, ThrottleRouteOption } from "./engine";

/**
 * Route-option typing for HTTP apps (AD-3): importing anything from `@spinejs/throttle/http` makes
 * `throttle` a fully-typed option of every verb helper. Without the battery, writing `throttle:`
 * in route options is a TS error (unknown property) — the transport carries no battery vocabulary.
 */
declare module "@spinejs/http-gateway" {
  // The type parameters must repeat the target interface's list verbatim for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RouteOptions<P, Q, B> {
    /**
     * Rate-limit policy for this route: inline `policies` (scoped `routeId#index`,
     * non-overridable), `skip` named gateway defaults, `override` them per-route — or `false` to
     * opt out of every default. Enforced by `@spinejs/throttle`'s interceptor.
     */
    throttle?: ThrottleRouteOption | false;
  }

  interface HttpRouteMeta {
    /** The stamped `meta.throttle` copy (user fields verbatim + `routeId`) — see AD-3. */
    throttle?: ThrottleRouteMeta;
  }
}
