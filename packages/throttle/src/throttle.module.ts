import { InjectionToken, Module } from "@spinejs/core";
import type { DynamicModule, OnInit, OnStop } from "@spinejs/core";
import type { GatewayContext } from "@spinejs/gateway-core";
import { validatePolicies, ThrottleConfigError } from "./policy-validation";
import { InMemoryThrottleStore } from "./memory-store";
import { ThrottleInterceptor } from "./interceptor";
import { ThrottleMetaValidator } from "./meta-validator";
import type { ResolvedThrottleConfig } from "./engine";
import type {
  Clock,
  KeySelector,
  LimitReachedEvent,
  ThrottleErrorEvent,
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
  /** Fired on every policy-evaluation failure (throwing selector/store) — fail-closed telemetry (FR-14). */
  onError?: (event: ThrottleErrorEvent) => void;
  /** Opt-in: also pass the raw (pre-hash) key to `onLimitReached` — off by default (PII). */
  emitRawKey?: boolean;
  /**
   * Outcome observer (AD-8): invoked once per dispatch; reads the outcome ctx slot via
   * `readThrottleOutcome(ctx)`. The `./http` preset's `throttleHttp()` wires its header translator
   * here automatically — HTTP presentation lives on `./http`, not hand-wired on this module.
   */
  onOutcome?: (ctx: GatewayContext) => void;
  /** Injectable time source for the default store (FR-21). Monotonic default. */
  clock?: Clock;
  /** Instance name for multi-gateway apps — each name is a fully isolated instance (AD-7). */
  name?: string;
}

// Internal per-instance tokens: each `configure()` returns a `fresh` module node providing its own
// values for them, so nothing leaks between named instances.
const storeToken = new InjectionToken<ThrottleStore>("throttle.store");
const ownsStoreToken = new InjectionToken<boolean>("throttle.owns-store");
const instanceNameToken = new InjectionToken<string>("throttle.instance-name");
const configToken = new InjectionToken<ResolvedThrottleConfig>(
  "throttle.config"
);

// Instance names claimed by the currently-booted modules of THIS app (added on `onInit`, released on
// `onStop`). Two `configure()` calls with the same name (incl. two implicit `default`s) would both
// export `throttleInterceptorRef(name)` and the container would silently keep the first (first-wins),
// merging quotas contra AD-7 — so a name reuse fails loud at boot. Scoped by lifecycle, not global:
// sequential apps that each stop cleanly can reuse a name freely.
const activeInstanceNames = new Set<string>();

// Public interceptor token registry, memoized per instance name — `throttleInterceptorRef("api")`
// always returns the same token object, so the providing node and the injecting app agree on it
// (the mikro-orm `mikroOrmRef` precedent).
const interceptorRefs = new Map<string, InjectionToken<ThrottleInterceptor>>();

// Public meta-validator token registry, memoized per instance name (mirrors `interceptorRefs`). The
// interceptor (runtime, per-request) and the meta-validator (boot-time, per-route) are two separate
// tokens of the same named instance: the app places the interceptor in `interceptors` and the
// validator in `metaValidators` of the SAME gateway.
const metaValidatorRefs = new Map<
  string,
  InjectionToken<ThrottleMetaValidator>
>();

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
 * The `MetaValidator` token of a named throttle instance (default instance when `name` is omitted).
 * Inject it where the gateway's `metaValidators` are provided — the SAME gateway whose `interceptors`
 * hold this instance's interceptor, so the routes validated at boot are exactly the routes enforced at
 * runtime (closes review findings F-B/F-C):
 *
 *   HttpGatewayModule.configure({
 *     interceptors:   { inject: [throttleInterceptorRef()],   factory: (t) => [t] },
 *     metaValidators: { inject: [throttleMetaValidatorRef()], factory: (v) => [v] },
 *     ...
 *   })
 */
export function throttleMetaValidatorRef(
  name = "default"
): InjectionToken<ThrottleMetaValidator> {
  let token = metaValidatorRefs.get(name);
  if (!token) {
    token = new InjectionToken<ThrottleMetaValidator>(
      `throttle.meta-validator.${name}`
    );
    metaValidatorRefs.set(name, token);
  }
  return token;
}

/**
 * Rate-limiting battery module. `configure({ policies, ... })` validates the configuration at boot
 * (NFR-3 — misconfiguration explodes at startup, never at request time) and returns an **isolated**
 * `fresh` module node exposing this instance's interceptor under `throttleInterceptorRef(name)` and
 * its boot-time `MetaValidator` under `throttleMetaValidatorRef(name)`.
 *
 * Per-gateway wiring (FR-2): the app places that interceptor in ONE gateway's `interceptors` and the
 * matching validator in the SAME gateway's `metaValidators`; a
 * multi-gateway app calls `configure({ name })` once per gateway — two names, two instances, two
 * stores. Config never merges per class (AD-7, the mikro-orm fresh-node precedent). No
 * configuration → no interceptor in the chain → no throttling and zero overhead.
 *
 * Store lifecycle: the module disposes the default store it created on stop (releasing the
 * reclamation sweep). A store the app passed in stays the app's to dispose — it may outlive one
 * gateway (e.g. a shared Redis-backed store).
 */
@Module({
  inject: [storeToken, ownsStoreToken, instanceNameToken, configToken] as const,
})
export class ThrottleModule implements OnInit, OnStop {
  constructor(
    private readonly store: ThrottleStore,
    private readonly ownsStore: boolean,
    private readonly instanceName: string,
    private readonly config: ResolvedThrottleConfig
  ) {}

  /** Claims this instance's name for the app, failing loud if another instance already holds it (AD-7). */
  onInit(): void {
    if (activeInstanceNames.has(this.instanceName)) {
      throw new ThrottleConfigError(
        this.instanceName,
        `a throttle instance named "${this.instanceName}" is already configured in this app — ` +
          "give each `ThrottleModule.configure()` a unique `name` (AD-7)"
      );
    }
    activeInstanceNames.add(this.instanceName);
  }

  /** Releases the name claim and disposes the owned default store (its unref'd sweep) when the app stops. */
  onStop(): void {
    activeInstanceNames.delete(this.instanceName);
    if (this.ownsStore) this.store.dispose?.();
  }

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
      onError: options.onError,
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
        { provide: ownsStoreToken, value: options.store === undefined },
        { provide: instanceNameToken, value: name },
        { provide: configToken, value: config },
        {
          provide: throttleInterceptorRef(name),
          inject: [storeToken] as const,
          factory: (store: ThrottleStore) =>
            new ThrottleInterceptor(config, store),
        },
        // Boot-time route-inline validation (NFR-3): the app places this in the gateway's
        // `metaValidators` slot and the gateway walks its own routes against it at start. Stateless
        // (reads only the resolved config), so no store dependency.
        {
          provide: throttleMetaValidatorRef(name),
          inject: [configToken] as const,
          factory: (resolved: ResolvedThrottleConfig) =>
            new ThrottleMetaValidator(resolved),
        },
      ],
      exports: [throttleInterceptorRef(name), throttleMetaValidatorRef(name)],
    };
  }
}
