import type { DispatchTarget, Envelope, GatewayContext } from "./gateway.types";
import type { JsonSchemaObject, ParseableSchema } from "./gateway.types";

/**
 * Validation port (DIP). A concrete adapter (e.g. a zod-backed one) parses the raw
 * input against the schema and **must throw `ValidationError`** on failure, so the lib
 * never depends on any validation library nor its error type.
 */
export interface Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T;
}

/**
 * Schema-conversion port (DIP). A concrete adapter (e.g. a zod-backed one) turns a schema
 * into a JSON Schema fragment, keeping the lib free of any schema library — exactly like
 * `Validator`. `io` selects which side of a transform-bearing schema to project: `"output"`
 * for responses, `"input"` for request bodies/params.
 */
export interface SchemaConverter {
  toJsonSchema(
    schema: ParseableSchema<unknown>,
    opts?: { io?: "input" | "output" }
  ): JsonSchemaObject;
}

/**
 * Builds the dispatch context from a transport's raw call data (e.g. the IPC event). Keeps every
 * app concern (session, user) out of the transport: the transport stays generic, the app provides
 * the factory that enriches the context.
 */
export interface ContextFactory<Raw, Ctx> {
  create(raw: Raw): Ctx;
}

/** Maps any thrown error to a transport-specific stable code (no raw message leaks). */
export interface ErrorMapper<Code extends string = string> {
  toCode(err: unknown): Code;
}

/**
 * Cross-cutting concern injected around every `dispatch()` call. Interceptors wrap the
 * pipeline in registration order — the first registered interceptor is the outermost wrapper.
 *
 * `Target` defaults to the transport-agnostic `DispatchTarget` (guards + input + invoke), so a
 * portable interceptor (e.g. `ClsInterceptor`, which only touches `ctx`) stays cross-transport. A
 * transport-specific interceptor that needs the route's `address`/`meta` narrows `Target` to its
 * own `LoadedRoute<Ctx, Addr>` — method-parameter bivariance keeps it assignable wherever a plain
 * `GatewayInterceptor` is expected.
 *
 * @example
 * class LoggingInterceptor implements GatewayInterceptor<Ctx, string, LoadedRoute<Ctx, string>> {
 *   async intercept(route, ctx, rawInput, next) {
 *     console.log('→', route.address);
 *     const envelope = await next();
 *     console.log('←', route.address, envelope.ok);
 *     return envelope;
 *   }
 * }
 */
export interface GatewayInterceptor<
  Ctx extends GatewayContext = GatewayContext,
  Code extends string = string,
  Target extends DispatchTarget<Ctx> = DispatchTarget<Ctx>
> {
  intercept(
    target: Target,
    ctx: Ctx,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown, Code>>
  ): Promise<Envelope<unknown, Code>>;
}

/**
 * Opt-in capability marker for an interceptor that ALSO enforces at a transport's **connection**
 * phase (e.g. an SSE connect on the HTTP gateway), not just per-request dispatch. Kept separate from
 * {@link GatewayInterceptor} on purpose: the shared cross-transport port stays a single method
 * forever, and every phase a transport adds owns its own marker (a future WebSocket gateway would
 * ship, say, `WsMessageInterceptor`). Presence of the method IS the opt-in — an interceptor that must
 * NOT run at connect (a request-scoped unit-of-work holding a DB transaction) simply omits
 * `interceptConnect`, so a connect chain filtered on it can never pull it in. The exclusion is
 * structural, not a convention.
 *
 * The signature mirrors `intercept` — there is no distinct "connect shape": short-circuit with a
 * failure envelope to DENY the connection, or call `next()` to ALLOW it. At connect, `next()` resolves
 * to a synthetic accept (there is no downstream handler), so do NOT do post-`next()` work that assumes
 * a real response.
 *
 * @example
 * class ThrottleInterceptor implements GatewayInterceptor, ConnectInterceptor {
 *   intercept(t, c, i, next)        { return this.gate(t, c, i, next); }
 *   interceptConnect(t, c, i, next) { return this.gate(t, c, i, next); } // same logic, one entry per phase
 *   private gate(t, c, i, next) { ... }
 * }
 */
export interface ConnectInterceptor<
  Ctx extends GatewayContext = GatewayContext,
  Code extends string = string,
  Target extends DispatchTarget<Ctx> = DispatchTarget<Ctx>
> {
  interceptConnect(
    target: Target,
    ctx: Ctx,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown, Code>>
  ): Promise<Envelope<unknown, Code>>;
}

/**
 * An interceptor usable in a chain narrowed to `<Ctx, Code, Route>`: either one typed for exactly that
 * transport (it may read the route's `address`/`meta`), or a **transport-agnostic** base
 * `GatewayInterceptor` that only touches `ctx`/`next` — e.g. `ClsInterceptor`, `MikroOrmInterceptor`.
 *
 * The base member is what lets a DI-provided, transport-agnostic interceptor drop into a transport's
 * `configure({ interceptors })` **without a cast**. A base `GatewayInterceptor<GatewayContext, …>` is
 * not assignable to a narrowed `GatewayInterceptor<Ctx, …, Route>` — the variance flows through
 * `DispatchTarget.invoke` (a contravariant function-property), and `intercept`'s method-parameter
 * bivariance only bridges the gap once `Ctx` already matches (why `new ClsInterceptor<Ctx>` fits but an
 * injected interceptor, fixed at `GatewayContext`, does not). The union admits the base shape
 * explicitly, so wiring reads `interceptors: [clsInterceptor, ormInterceptor]` with no `as`.
 */
export type ChainInterceptor<
  Ctx extends GatewayContext = GatewayContext,
  Code extends string = string,
  Route extends DispatchTarget<Ctx> = DispatchTarget<Ctx>
> = GatewayInterceptor<Ctx, Code, Route> | GatewayInterceptor;

/**
 * Boot-time, per-route validator for one battery's namespaced slice of a route's `meta` (e.g.
 * `meta.throttle`). A gateway crosses its own routes × its own registered `MetaValidator`s at start
 * and, for every route whose `meta` carries `namespace`, calls `validate(routeId, meta[namespace])` —
 * a throw fails boot with the route named, before the transport opens.
 *
 * Deliberately a **separate** concept from {@link GatewayInterceptor}/{@link ConnectInterceptor}
 * (Fab's explicit requirement): those are runtime, per-request/per-connect wrappers; this is
 * boot-time, per-route, and never runs on the dispatch path. Different type, different configure slot,
 * different lifecycle — do not conflate them. The gateway owns both halves of the walk (its routes and
 * its validators), so a battery validates the exact routes it enforces with no app-side plumbing.
 */
export interface MetaValidator {
  /** The `meta` key this validator owns (e.g. `"throttle"`). Only routes carrying it are validated. */
  readonly namespace: string;
  /** Throws a typed config error (route named) when `meta[namespace]` is invalid; returns otherwise. */
  validate(routeId: string, meta: unknown): void;
}

/** Thrown by a `Validator` adapter when the input fails its schema. */
export class ValidationError extends Error {
  constructor(message = "Input validation failed") {
    super(message);
    this.name = "ValidationError";
  }
}

/** Thrown by the pipeline when a guard rejects the call. */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
