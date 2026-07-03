import type {
  GatewayContext,
  GuardConstructor,
  ParseableSchema,
} from "./gateway.types";

/** Stable brand (Symbol.for, survives module copies) flagging a value as a field route marker. */
export const ROUTE_MARKER = Symbol.for("app-gateway:route-marker");

/**
 * Transport-agnostic route declared as a controller **instance field** (not a `@Handler` method).
 * A transport (e.g. HTTP) builds these via a typed helper; `getRoutes` scans the controller's own
 * enumerable fields, picks the ones carrying `ROUTE_MARKER`, and turns them into `LoadedRoute`s.
 *
 * `address` is the transport's opaque address; `input` is the composed schema validated by the
 * pipeline; `invoke` is the user callback; `guards` are per-route guard classes (merged after the
 * controller's class-level `@UseGuards`, resolved by DI at registration); `meta` carries opaque
 * per-transport extras (e.g. split schemas + a response schema for OpenAPI, an HTTP success status)
 * — carried only, never interpreted by the core.
 */
export interface RouteMarker<Ctx extends GatewayContext, Addr = unknown> {
  [ROUTE_MARKER]: true;
  address: Addr;
  input?: ParseableSchema<unknown>;
  guards?: GuardConstructor[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (ctx: Ctx, input: any) => unknown;
  meta?: unknown;
}

/**
 * Shared builder every transport's field-route helper composes (HTTP `httpRoutes`, IPC `ipcRoutes`).
 * Owns the boilerplate that is identical across transports: the `ROUTE_MARKER` brand and the
 * argument **flip** — the user writes `(input, ctx)` (input first, so `ctx` can be omitted) while the
 * pipeline calls `invoke(ctx, input)`. The transport only supplies its `address`, the already-composed
 * `input` schema, its opaque `meta`, and optional per-route `guards`.
 */
export function makeRouteMarker<Ctx extends GatewayContext, Addr, In>(spec: {
  address: Addr;
  input?: ParseableSchema<unknown>;
  fn: (input: In, ctx: Ctx) => unknown;
  guards?: GuardConstructor[];
  meta?: unknown;
}): RouteMarker<Ctx, Addr> {
  return {
    [ROUTE_MARKER]: true,
    address: spec.address,
    input: spec.input,
    guards: spec.guards,
    invoke: (ctx: Ctx, input: In) => spec.fn(input, ctx),
    meta: spec.meta,
  };
}

/** True when a value carries the route-marker brand. */
export function isRouteMarker(
  value: unknown
): value is RouteMarker<GatewayContext, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[ROUTE_MARKER] === true
  );
}
