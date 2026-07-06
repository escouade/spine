/**
 * Structural schema contract used by the validation pipeline. Anything exposing a
 * `parse(input) -> T` satisfies it — notably a zod schema — so the gateway lib infers
 * the validated type **without importing any validation library** (stays dep-free).
 */
export interface ParseableSchema<T> {
  parse(input: unknown): T;
}

/** Base constraint for a transport context (IPC event + session, HTTP req/res, …). */
export type GatewayContext = object;

/**
 * Machine-readable context a producer (an interceptor, a battery) may attach to a failure
 * envelope. **Semantic only** — values are transport-blind durations/quantities, never
 * presentation (no HTTP header names): each transport surfaces them natively (HTTP maps them
 * to headers, IPC clients read them off the envelope). Named fields are documented here as
 * batteries claim them (`retryAfterMs` = rate limiting); the index signature lets a battery
 * carry additional documented, JSON-serializable fields without another core change.
 */
export interface FailureMeta {
  /** Relative duration (ms) after which the client may retry — set by rate limiting. */
  retryAfterMs?: number;
  /** Additional documented, JSON-serializable semantic fields owned by their producer. */
  [key: string]: JsonValue | undefined;
}

/**
 * Result wrapper returned by every handler, transport-agnostic. `Code` is the set of
 * stable error codes a given transport maps its exceptions to (opaque to the lib).
 * The failure arm optionally carries semantic {@link FailureMeta} (e.g. `retryAfterMs`),
 * preserved verbatim by the pipeline and every transport — additive, never required.
 */
export type Envelope<T, Code extends string = string> =
  | { ok: true; data: T }
  | { ok: false; code: Code; meta?: FailureMeta };

/**
 * Injectable guard: decides whether a context is allowed to proceed. Replaces the old
 * `AuthGuard` port — guards are now plain classes resolved by DI, not gateway ports.
 */
export interface Guard<Ctx extends GatewayContext> {
  canActivate(ctx: Ctx): boolean | Promise<boolean>;
}

/** Constructor type for a guard class, used as the metadata key and DI token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GuardConstructor = new (...args: any[]) => Guard<GatewayContext>;

/**
 * Minimal shape the dispatch pipeline consumes: guards + optional input schema + the bound handler.
 * Transport-agnostic — it carries **no address**. The pipeline (`DispatchPipeline`) is a helper a
 * transport *composes*, not a base it extends; each transport's loaded route extends this target.
 */
export interface DispatchTarget<Ctx extends GatewayContext> {
  /** Guards to run before invoking the handler. Any returning false throws UnauthorizedError. */
  guards: Guard<Ctx>[];
  /** Optional schema; when present the raw input is parsed/narrowed before `invoke`. */
  input?: ParseableSchema<unknown>;
  /** The controller handler, bound to its instance. Receives the validated input. */
  invoke: (ctx: Ctx, input: unknown) => unknown | Promise<unknown>;
}

/**
 * A route resolved by `getRoutes` from controller metadata: a `DispatchTarget` plus the transport's
 * own `address` and opaque per-transport `meta`. This is the **loader's output** that a transport
 * registers — not a shared base contract. Each transport binds `Addr` to its own address model
 * (HTTP: `{ method, path }`; IPC: a string channel) and reads `meta` as it sees fit.
 */
export interface LoadedRoute<Ctx extends GatewayContext, Addr = string>
  extends DispatchTarget<Ctx> {
  address: Addr;
  /**
   * Opaque per-transport extras carried from a field route marker (e.g. split input schemas +
   * a response schema reserved for OpenAPI generation). The pipeline never interprets it.
   */
  meta?: unknown;
}

/** Any JSON-serializable value. Dependency-free — the structural half of {@link JsonSchemaObject}. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON-serializable JSON Schema fragment — the output of a {@link SchemaConverter}. Kept as a
 * structural, dependency-free shape (no zod, no OpenAPI types) so `gateway-core` stays lib-free;
 * the OpenAPI battery downstream refines the precise field modelling when it assembles the document.
 */
export type JsonSchemaObject = { [key: string]: JsonValue };
