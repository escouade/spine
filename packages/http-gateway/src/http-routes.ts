import { makeRouteMarker } from "@spinejs/gateway-core";
import type {
  GuardConstructor,
  ParseableSchema,
  RouteMarker,
} from "@spinejs/gateway-core";
import type {
  HttpAddress,
  HttpBaseContext,
  HttpMethod,
} from "./http-base.types";
import type { SseEvent } from "./sse-hub";

/** One extra documented response status. Opaque to the transport — read only by `@spinejs/openapi`. */
export interface RouteResponseDoc {
  /** The stable error code documented for this status (mirrors the error envelope's `code`). */
  code?: string;
  /** Schema of this status's body, when it carries one. */
  schema?: ParseableSchema<unknown>;
  /** Human description of the status. */
  description?: string;
}

/**
 * Optional OpenAPI documentation an author may attach to a route. Every field is optional and inert
 * to the transport — carried on the marker's `meta` and interpreted only by the OpenAPI battery
 * (`@spinejs/openapi`). Adding these never changes runtime dispatch (NFR-4).
 */
export interface RouteDocMeta {
  /** Short operation summary. */
  summary?: string;
  /** Longer operation description. */
  description?: string;
  /** Tags grouping the operation in the document. */
  tags?: string[];
  /** Explicit operationId (else auto-derived from method + path). */
  operationId?: string;
  /** Marks the operation deprecated. */
  deprecated?: boolean;
  /** Response examples, keyed by name (shape interpreted by the OpenAPI battery). */
  examples?: Record<string, unknown>;
  /**
   * Additional documented statuses beyond the success/error envelope, keyed by HTTP status code.
   * Note the plural: distinct from `RouteOptions.response` (singular — the success body schema).
   */
  responses?: Record<number, RouteResponseDoc>;
  /** Exclude this route from the generated OpenAPI document. It still serves normally. */
  hidden?: boolean;
}

/**
 * Per-route options for a field route. Each input source (`params`/`query`/`body`) is optional; only
 * the provided ones are validated and surfaced to the callback. `response` is reserved for OpenAPI
 * generation — carried in the marker's `meta`, never validated. `guards` are per-route guard classes
 * (merged after the controller's class-level `@UseGuards`). `successStatus` overrides the default
 * `200` on a successful envelope (e.g. `201` for a creation). The `RouteDocMeta` fields
 * (`summary`, `tags`, `hidden`, …) are optional OpenAPI documentation, inert to dispatch.
 */
export interface RouteOptions<P, Q, B> extends RouteDocMeta {
  params?: ParseableSchema<P>;
  query?: ParseableSchema<Q>;
  body?: ParseableSchema<B>;
  response?: ParseableSchema<unknown>;
  guards?: GuardConstructor[];
  successStatus?: number;
  /** Static response headers added on a successful envelope (override the default `Content-Type`). */
  headers?: Record<string, string>;
}

/**
 * The structured input handed to the callback: an object with ONLY the provided source keys, each
 * typed as that schema's inferred output. e.g. `{ query, body }` schemas → `{ query: Q; body: B }`.
 *
 * Driven by the *actual* options object type `S` (inferred at the call site from the passed literal),
 * NOT by `RouteOptions<P,Q,B>` whose keys are all optional — an absent key has type `undefined` and
 * its `NonNullable` falls through to `unknown`, which an intersection drops. Implemented as a mapped
 * type keyed by the present sources, so omitted sources — and the non-schema keys (`response`,
 * `guards`, `successStatus`) — disappear from the result entirely.
 */
type SchemaOutput<T> = NonNullable<T> extends ParseableSchema<infer V>
  ? V
  : never;

export type InputOf<S> = {
  [K in keyof S as K extends "params" | "query" | "body"
    ? undefined extends S[K]
      ? never
      : K
    : never]: SchemaOutput<S[K]>;
};

/** Raw structured shape the HTTP gateway extracts before validation. */
interface RawHttpInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

/**
 * Builds a `ParseableSchema` over the structured `{ params, query, body }` input by delegating each
 * present source to its own schema's `.parse`. Dep-free: only the structural `parse` contract is
 * used, so any zod schema (or anything `ParseableSchema`) composes without importing a validator.
 */
function composeInput<P, Q, B>(
  options: RouteOptions<P, Q, B>
): ParseableSchema<unknown> {
  return {
    parse(input: unknown): unknown {
      const raw = (input ?? {}) as Partial<RawHttpInput>;
      const out: Record<string, unknown> = {};
      if (options.params) out.params = options.params.parse(raw.params);
      if (options.query) out.query = options.query.parse(raw.query);
      if (options.body) out.body = options.body.parse(raw.body);
      return out;
    },
  };
}

/**
 * Per-transport extras carried on the marker's `meta` (never interpreted by the core): the split
 * input schemas + the `response` schema (for OpenAPI) and the optional per-route success status.
 */
export interface HttpRouteMeta extends RouteDocMeta {
  inputs: {
    params?: ParseableSchema<unknown>;
    query?: ParseableSchema<unknown>;
    body?: ParseableSchema<unknown>;
  };
  response?: ParseableSchema<unknown>;
  successStatus?: number;
  headers?: Record<string, string>;
  /** Marks an SSE (event-stream) route: the HTTP transport streams events instead of buffering an envelope. */
  sse?: boolean;
}

/**
 * App-wide context registry — augmented ONCE per app (like `Express.Request`) to declare the
 * `ContextFactory`'s output type as the default `ctx` of every route:
 *
 *   declare module "@spinejs/http-gateway" {
 *     interface HttpContextRegistry { context: AppContext }
 *   }
 *
 * Without this augmentation `DefaultCtx` falls back to `HttpBaseContext`, so `ctx.user` (any
 * app-specific field) does NOT exist. The augmentation is mandatory to type app concerns on `ctx`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HttpContextRegistry {}

/**
 * The default `ctx` type of a route: the registry's `context` when augmented, else `HttpBaseContext`.
 * A route overrides it per-call by annotating the callback's `ctx` param (`(input, ctx: Other) =>`).
 */
export type DefaultCtx = HttpContextRegistry extends {
  context: infer C extends HttpBaseContext;
}
  ? C
  : HttpBaseContext;

/**
 * A typed per-verb helper: `(path, options, fn) => RouteMarker`. The callback takes the validated
 * `input` first (inferred from the schemas, split by source) and `ctx` last — so a route that does
 * not touch the context just writes `(input) => ...` (a 1-arg fn is assignable to the 2-arg type),
 * while one that needs it writes `(input, ctx) => ...` with `ctx` still fully typed, no annotation.
 */
export type RouteHelper<Ctx extends HttpBaseContext> = <
  S extends RouteOptions<unknown, unknown, unknown>,
  Out
>(
  path: string,
  options: S,
  fn: (input: InputOf<S>, ctx: Ctx) => Out
) => RouteMarker<Ctx, HttpAddress>;

/** The set of per-verb helpers returned by `httpRoutes`. `del` maps to `DELETE` (reserved word). */
export interface HttpRouteHelpers<Ctx extends HttpBaseContext> {
  get: RouteHelper<Ctx>;
  post: RouteHelper<Ctx>;
  put: RouteHelper<Ctx>;
  patch: RouteHelper<Ctx>;
  del: RouteHelper<Ctx>;
}

/** Shared runtime builder: assembles the marker from `method` + options + callback (type-agnostic). */
function buildMarker<
  Ctx extends HttpBaseContext,
  S extends RouteOptions<unknown, unknown, unknown>,
  Out
>(
  method: HttpMethod,
  path: string,
  options: S,
  fn: (input: InputOf<S>, ctx: Ctx) => Out
): RouteMarker<Ctx, HttpAddress> {
  const meta: HttpRouteMeta = {
    inputs: {
      params: options.params,
      query: options.query,
      body: options.body,
    },
    response: options.response,
    successStatus: options.successStatus,
    headers: options.headers,
    // OpenAPI doc metadata (RouteDocMeta) — carried, never interpreted by the transport. Only the
    // provided fields are added, so a route with no doc options yields a minimal `meta` (no
    // `undefined`-valued keys) — matching the `sse()` path and keeping downstream output stable.
    ...(options.summary !== undefined && { summary: options.summary }),
    ...(options.description !== undefined && {
      description: options.description,
    }),
    ...(options.tags !== undefined && { tags: options.tags }),
    ...(options.operationId !== undefined && {
      operationId: options.operationId,
    }),
    ...(options.deprecated !== undefined && { deprecated: options.deprecated }),
    ...(options.examples !== undefined && { examples: options.examples }),
    ...(options.responses !== undefined && { responses: options.responses }),
    ...(options.hidden !== undefined && { hidden: options.hidden }),
  };
  // Namespaced battery meta (AD-3): the user's `throttle` option fields are copied VERBATIM under
  // `meta.throttle` with exactly one stamped field added — `routeId` ("METHOD /path", the declared
  // path template). The transport never interprets the fields (opaque copy); `throttle: false` is
  // encoded as `disabled: true`. The option itself is typed only by @spinejs/throttle's
  // `declare module` augmentation — without the battery, `throttle:` is an unknown property.
  const throttleOption = (options as { throttle?: unknown }).throttle;
  (meta as { throttle?: unknown }).throttle = {
    ...(throttleOption === false
      ? { disabled: true }
      : (throttleOption as object | undefined)),
    routeId: `${method} ${path}`,
  };
  return makeRouteMarker<Ctx, HttpAddress, InputOf<S>>({
    address: { method, path },
    input: composeInput(options),
    fn,
    guards: options.guards,
    meta,
  });
}

/**
 * A module-level per-verb route function. `Ctx` defaults to `DefaultCtx` (the registry) when the
 * callback's `ctx` is left unannotated, and is inferred from the annotation when a route overrides
 * it (`(input, ctx: Other) =>`). `input` is always inferred from the options literal `S`.
 */
export type RouteFn = <
  S extends RouteOptions<unknown, unknown, unknown>,
  Out,
  Ctx extends HttpBaseContext = DefaultCtx
>(
  path: string,
  options: S,
  fn: (input: InputOf<S>, ctx: Ctx) => Out
) => RouteMarker<Ctx, HttpAddress>;

/** Builds one module-level per-verb function bound to `method`, generic over the per-route `Ctx`. */
function makeRouteFn(method: HttpMethod): RouteFn {
  return <
    S extends RouteOptions<unknown, unknown, unknown>,
    Out,
    Ctx extends HttpBaseContext = DefaultCtx
  >(
    path: string,
    options: S,
    fn: (input: InputOf<S>, ctx: Ctx) => Out
  ): RouteMarker<Ctx, HttpAddress> => buildMarker(method, path, options, fn);
}

/**
 * Framework-level route helpers — the recommended API. Import them straight from
 * `@spinejs/http-gateway`; no per-app factory file. The `ctx` of each callback defaults to
 * `DefaultCtx` (your app context, declared once via the `HttpContextRegistry` augmentation) and can
 * be overridden per route by annotating the callback's `ctx` param. `input` is inferred from the
 * options literal — split by source (`params`/`query`/`body`). Declare routes as instance fields:
 *
 *   import { get, post } from "@spinejs/http-gateway";
 *
 *   class UsersController {
 *     list   = get("/users", { query: listQuerySchema }, ({ query }) => ...);
 *     create = post("/users", { body: createSchema, successStatus: 201 }, ({ body }) => ...);
 *     // needs ctx:      whoami = get("/me", {}, (_input, ctx) => ctx.user);
 *     // ctx override:   ping   = get("/ping", {}, (_input, ctx: OtherCtx) => ...);
 *   }
 *
 * `getRoutes` (in `@spinejs/gateway-core`) picks the markers off the instance fields at registration.
 */
export const get: RouteFn = makeRouteFn("GET");
export const post: RouteFn = makeRouteFn("POST");
export const put: RouteFn = makeRouteFn("PUT");
export const patch: RouteFn = makeRouteFn("PATCH");
export const del: RouteFn = makeRouteFn("DELETE");

/** Builds one per-verb helper bound to `method` and the chosen context type `Ctx`. */
function makeHelper<Ctx extends HttpBaseContext>(
  method: HttpMethod
): RouteHelper<Ctx> {
  return <S extends RouteOptions<unknown, unknown, unknown>, Out>(
    path: string,
    options: S,
    fn: (input: InputOf<S>, ctx: Ctx) => Out
  ): RouteMarker<Ctx, HttpAddress> => buildMarker(method, path, options, fn);
}

/**
 * @deprecated Prefer the module-level `get`/`post`/`put`/`patch`/`del` from `@spinejs/http-gateway`
 * plus a one-time `HttpContextRegistry` augmentation for the default `ctx`. This factory (which binds
 * a context type per app file) is kept only for a soft transition and will be removed.
 *
 * Field-wrapper route API ("solution A"). Returns per-verb helpers bound to a context type, so the
 * callback's `input` is INFERRED from the schemas — split by source (`params`/`query`/`body`) — and
 * `ctx` (last arg) is typed WITHOUT annotation. Omit `ctx` when unused. Declare routes as fields:
 *
 *   const { get, post, put, patch, del } = httpRoutes<AppContext>();
 */
export function httpRoutes<
  Ctx extends HttpBaseContext = HttpBaseContext
>(): HttpRouteHelpers<Ctx> {
  return {
    get: makeHelper<Ctx>("GET"),
    post: makeHelper<Ctx>("POST"),
    put: makeHelper<Ctx>("PUT"),
    patch: makeHelper<Ctx>("PATCH"),
    del: makeHelper<Ctx>("DELETE"),
  };
}

/**
 * Options for an `sse()` event-stream route. `GET` only — no `body`, no `successStatus`, no
 * `response` (the stream owns the response). `params`/`query` are validated like any route.
 */
export interface SseRouteOptions<P, Q> {
  params?: ParseableSchema<P>;
  query?: ParseableSchema<Q>;
  guards?: GuardConstructor[];
  /** Static headers added to the `text/event-stream` response. */
  headers?: Record<string, string>;
}

/**
 * A module-level Server-Sent Events route: a long-lived `GET` whose callback returns an
 * `AsyncIterable<SseEvent>` — typically an `SseHub` subscription. The HTTP transport runs guards +
 * input validation, then streams every yielded event until the client disconnects; it does NOT
 * buffer an envelope. `input` is inferred from `params`/`query`; `ctx` defaults to `DefaultCtx`.
 *
 *   import { sse, SseHub } from "@spinejs/http-gateway";
 *
 *   class JobsController {
 *     constructor(private jobs: JobsHub) {}
 *     stream = sse("/jobs/stream", {}, (_input, ctx) => this.jobs.subscribe(ctx.user.id));
 *   }
 */
export type SseRouteFn = <
  S extends SseRouteOptions<unknown, unknown>,
  Ctx extends HttpBaseContext = DefaultCtx
>(
  path: string,
  options: S,
  fn: (input: InputOf<S>, ctx: Ctx) => AsyncIterable<SseEvent>
) => RouteMarker<Ctx, HttpAddress>;

export const sse: SseRouteFn = <
  S extends SseRouteOptions<unknown, unknown>,
  Ctx extends HttpBaseContext = DefaultCtx
>(
  path: string,
  options: S,
  fn: (input: InputOf<S>, ctx: Ctx) => AsyncIterable<SseEvent>
): RouteMarker<Ctx, HttpAddress> => {
  const meta: HttpRouteMeta = {
    inputs: { params: options.params, query: options.query },
    headers: options.headers,
    sse: true,
  };
  return makeRouteMarker<Ctx, HttpAddress, InputOf<S>>({
    address: { method: "GET", path },
    input: composeInput({ params: options.params, query: options.query }),
    fn,
    guards: options.guards,
    meta,
  });
};
