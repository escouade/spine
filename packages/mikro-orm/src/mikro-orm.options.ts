import { InjectionToken } from "@spinejs/core";
import type { Options } from "@mikro-orm/core";

/**
 * CLS key holding **this request's forked `EntityManager`**. Internal to the package: shared by the
 * `MikroORM` factory (whose `context` hook reads it) and the `MikroOrmInterceptor` (which writes it).
 *
 * ADR 0016 §1 sketches this as a `Symbol`; the concrete key is a namespaced **string** because
 * `ClsService.get/set` are typed `K extends keyof T & string` — the store is keyed by strings, not
 * symbols. The mechanism (spine's CLS is MikroORM's context store) is identical to the ADR/spike.
 */
export const EM = "@spinejs/mikro-orm:em";

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
 */
export type MikroOrmModuleOptions = Options & { retry?: Partial<RetryPolicy> };

/** Value token carrying the MikroORM options (retry stripped) to the `MikroORM` factory. */
export const mikroOrmOptionsToken = new InjectionToken<Options>(
  "mikro-orm.options"
);

/** Value token carrying the resolved (defaults-merged) retry policy to the module's `onStart`. */
export const retryPolicyToken = new InjectionToken<RetryPolicy>(
  "mikro-orm.retry"
);
