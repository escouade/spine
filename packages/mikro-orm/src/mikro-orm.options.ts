import { InjectionToken } from "@spinejs/core";
import type { EntityManager, MikroORM, Options } from "@mikro-orm/core";
// Type-only: avoids a runtime import cycle (mikro-orm.interceptor.ts imports EM from here).
import type { MikroOrmInterceptor } from "./mikro-orm.interceptor";

/**
 * The default connection's name. `configure(options)` with no `name` registers this one; it keeps the
 * `MikroORM`/`EntityManager` **class tokens** and the plain `EM` CLS key, so single-connection apps are
 * unaffected by named connections (ADR 0016, Amendment 1).
 */
export const DEFAULT_CONNECTION = "default";

/**
 * CLS key holding **this request's forked `EntityManager`** for the default connection. Internal to the
 * package: shared by the `MikroORM` factory (whose `context` hook reads it) and the `MikroOrmInterceptor`
 * (which writes it).
 *
 * ADR 0016 §1 sketches this as a `Symbol`; the concrete key is a namespaced **string** because
 * `ClsService.get/set` are typed `K extends keyof T & string` — the store is keyed by strings, not
 * symbols. The mechanism (spine's CLS is MikroORM's context store) is identical to the ADR/spike.
 */
export const EM = "@spinejs/mikro-orm:em";

/**
 * CLS key holding a request's fork for a **named** connection (ADR 0016, Amendment 1). The default
 * connection keeps the plain {@link EM} key, so its behaviour is byte-for-byte unchanged; every other
 * name namespaces under it. Each connection's interceptor writes its own key and its `MikroORM`'s
 * `context` hook reads the same one, so N connections never cross request forks.
 */
export const emKey = (name: string): string =>
  name === DEFAULT_CONNECTION ? EM : `@spinejs/mikro-orm:em:${name}`;

/**
 * CLS key of the per-request **write-once guard** (ADR 0016, Amendment 1). Shared by every connection's
 * interceptor in a request: the first connection whose unit-of-work is dirty sets it; a second dirty
 * connection then throws (cross-DB writes have no atomicity without 2PC) — unless that connection opted
 * into `multiWrite`. With a single connection it is set once and never re-checked, so nothing changes.
 */
export const WROTE = "@spinejs/mikro-orm:wrote";

// Memoized per-name tokens: `xRef(name)` returns the SAME token every call, so a provider and an
// `inject:` site resolve the same identity (ADR 0007). One map per token kind.
const mikroOrmRefs = new Map<string, InjectionToken<MikroORM>>();
const entityManagerRefs = new Map<string, InjectionToken<EntityManager>>();
const interceptorRefs = new Map<string, InjectionToken<MikroOrmInterceptor>>();

const memo = <T>(
  map: Map<string, InjectionToken<T>>,
  name: string,
  label: string
): InjectionToken<T> => {
  let token = map.get(name);
  if (!token) {
    token = new InjectionToken<T>(label);
    map.set(name, token);
  }
  return token;
};

/**
 * Injection token for a **named** connection's `MikroORM` instance (ADR 0016, Amendment 1).
 * `mikroOrmRef("reporting")` — inject a specific connection where the class token would be ambiguous.
 * `mikroOrmRef("default")` resolves the same instance as the `MikroORM` class token (an `existing`
 * alias registered by `configure()`), so name-based and class-token code never diverge.
 */
export const mikroOrmRef = (name: string): InjectionToken<MikroORM> =>
  memo(mikroOrmRefs, name, `mikroOrmRef(${name})`);

/** Injection token for a named connection's request-scoped `EntityManager` (see {@link mikroOrmRef}). */
export const entityManagerRef = (name: string): InjectionToken<EntityManager> =>
  memo(entityManagerRefs, name, `entityManagerRef(${name})`);

/**
 * Injection token for a named connection's `MikroOrmInterceptor` — the one to stack in that transport's
 * `interceptors` (each connection brackets its own request fork). See {@link mikroOrmRef}.
 */
export const mikroOrmInterceptorRef = (
  name: string
): InjectionToken<MikroOrmInterceptor> =>
  memo(interceptorRefs, name, `mikroOrmInterceptorRef(${name})`);

/**
 * Startup connection-retry policy. A transient failure (a DB container still booting, a brief network
 * blip) is retried with backoff before boot is aborted — ADR 0016 §4.
 */
export interface RetryPolicy {
  /** Total connect attempts, including the first (>= 1). */
  attempts: number;
  /** Delay before the first retry, in ms. */
  delayMs: number;
  /** Multiplier applied to the delay after each failed attempt (1 = constant delay). */
  backoff: number;
}

/**
 * Sane defaults: 5 attempts with an exponential backoff starting at 200ms
 * (200 → 400 → 800 → 1600ms between the four retries), so a DB that needs a few seconds to come up
 * does not abort the boot on the first failed attempt.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 5,
  delayMs: 200,
  backoff: 2,
};

/**
 * Options for `MikroOrmModule.configure()`: the full MikroORM `Options` (driver, `dbName`, `entities`,
 * pool, …) plus an optional startup `retry` policy. Any field omitted from `retry` falls back to
 * {@link DEFAULT_RETRY}.
 *
 * Two optional fields configure a **named** connection (ADR 0016, Amendment 1):
 * - `name` — register this connection under a name (injectable via `mikroOrmRef(name)` etc.). Omitted =
 *   the default connection (class tokens, byte-for-byte the single-connection behaviour).
 * - `multiWrite` — allow this connection to be written in a request that already wrote another
 *   connection. Off by default: a second dirty connection throws (cross-DB writes have no atomicity).
 *   Opting in gives **best-effort sequential** flush — a mid-sequence failure strands earlier commits.
 */
export type MikroOrmModuleOptions = Options & {
  retry?: Partial<RetryPolicy>;
  name?: string;
  multiWrite?: boolean;
};

/** Value token carrying the MikroORM options (retry stripped) to the `MikroORM` factory. */
export const mikroOrmOptionsToken = new InjectionToken<Options>(
  "mikro-orm.options"
);

/** Value token carrying the resolved (defaults-merged) retry policy to the module's `onStart`. */
export const retryPolicyToken = new InjectionToken<RetryPolicy>(
  "mikro-orm.retry"
);
