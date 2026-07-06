import { InjectionToken, Module } from "@spinejs/core";
import type { DynamicModule } from "@spinejs/core";
import type { GatewayContext } from "@spinejs/gateway-core";
import { validatePolicies } from "./policy-validation";
import { InMemoryThrottleStore } from "./memory-store";
import { ThrottleInterceptor } from "./interceptor";
import type { ResolvedThrottleConfig } from "./interceptor";
import type {
  Clock,
  KeySelector,
  LimitReachedEvent,
  ThrottleOutcome,
  ThrottlePolicy,
  ThrottleStore,
} from "./throttle.types";

/** Options of one `ThrottleModule.configure()` call (FR-2). */
export interface ThrottleModuleOptions {
  /** Gateway-default policies, keyed by name — applied to every dispatch unless a route skips/opts out. */
  policies: Record<string, ThrottlePolicy>;
  /** Custom store (e.g. Redis). Defaults to the built-in in-memory sliding-log store, owned by the module. */
  store?: ThrottleStore;
  /** Named key sources `keyBy` strings resolve through (`'ip'`/`'sender'` from the presets, `'identity'` app-wired). */
  keySources?: Record<string, KeySelector>;
  /** Fired on every rejection with `{ policyName, routeId, keyHash, retryAfterMs }` (FR-14). */
  onLimitReached?: (event: LimitReachedEvent) => void;
  /** Opt-in: also pass the raw (pre-hash) key to `onLimitReached` — off by default (PII). */
  emitRawKey?: boolean;
  /** Outcome observer (AD-8): the `./http` preset's header translator plugs in here. */
  onOutcome?: (ctx: GatewayContext, outcome: ThrottleOutcome) => void;
  /** Injectable time source for the default store (FR-21). Monotonic default. */
  clock?: Clock;
  /** Instance name for multi-gateway apps — each name is a fully isolated instance (AD-7). */
  name?: string;
}

// Internal per-instance tokens: each `configure()` returns a `fresh` module node providing its own
// values for them, so nothing leaks between named instances.
const storeToken = new InjectionToken<ThrottleStore>("throttle.store");

// Public interceptor token registry, memoized per instance name — `throttleInterceptorRef("api")`
// always returns the same token object, so the providing node and the injecting app agree on it
// (the mikro-orm `mikroOrmRef` precedent).
const interceptorRefs = new Map<string, InjectionToken<ThrottleInterceptor>>();

/**
 * The interceptor token of a named throttle instance (default instance when `name` is omitted).
 * Inject it where the gateway's `interceptors` are provided and place it **first** (outermost):
 *
 *   HttpGatewayModule.configure({
 *     interceptors: {
 *       inject: [throttleInterceptorRef()],
 *       factory: (throttle: ThrottleInterceptor) => [throttle],
 *     },
 *     ...
 *   })
 */
export function throttleInterceptorRef(
  name = "default"
): InjectionToken<ThrottleInterceptor> {
  let token = interceptorRefs.get(name);
  if (!token) {
    token = new InjectionToken<ThrottleInterceptor>(
      `throttle.interceptor.${name}`
    );
    interceptorRefs.set(name, token);
  }
  return token;
}

/**
 * Rate-limiting battery module. `configure({ policies, ... })` validates the configuration at boot
 * (NFR-3 — misconfiguration explodes at startup, never at request time) and returns an **isolated**
 * `fresh` module node exposing this instance's interceptor under `throttleInterceptorRef(name)`.
 *
 * Per-gateway wiring (FR-2): the app places that interceptor in ONE gateway's `interceptors`; a
 * multi-gateway app calls `configure({ name })` once per gateway — two names, two instances, two
 * stores. Config never merges per class (AD-7, the mikro-orm fresh-node precedent). No
 * configuration → no interceptor in the chain → no throttling and zero overhead.
 */
@Module({})
export class ThrottleModule {
  static configure(options: ThrottleModuleOptions): DynamicModule {
    const name = options.name ?? "default";
    const keySources = options.keySources ?? {};
    // Fail at boot: `configure()` runs while the module graph is composed.
    validatePolicies(options.policies, keySources);

    const config: ResolvedThrottleConfig = {
      name,
      policies: options.policies,
      keySources,
      onLimitReached: options.onLimitReached,
      emitRawKey: options.emitRawKey ?? false,
      onOutcome: options.onOutcome,
    };

    return {
      module: ThrottleModule,
      // Isolated instance per configure() call: identity = this object, never the class (AD-7).
      fresh: true,
      providers: [
        // Default store: the built-in in-memory sliding log, owned by this instance (one store
        // per named instance — quotas never shared across gateways, AD-7).
        {
          provide: storeToken,
          factory: () =>
            options.store ??
            new InMemoryThrottleStore({ clock: options.clock }),
        },
        {
          provide: throttleInterceptorRef(name),
          inject: [storeToken] as const,
          factory: (store: ThrottleStore) =>
            new ThrottleInterceptor(config, store),
        },
      ],
      exports: [throttleInterceptorRef(name)],
    };
  }
}
