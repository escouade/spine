import type { DispatchTarget, Envelope, GatewayContext } from "./gateway.types";
import type { ParseableSchema } from "./gateway.types";

/**
 * Validation port (DIP). A concrete adapter (e.g. a zod-backed one) parses the raw
 * input against the schema and **must throw `ValidationError`** on failure, so the lib
 * never depends on any validation library nor its error type.
 */
export interface Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T;
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
