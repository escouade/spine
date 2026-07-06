import { InjectionToken, Module } from "@spinejs/core";
import type { DynamicModule, OnInit, OnStart, OnStop } from "@spinejs/core";
import type { GatewayContext, ProviderAdapter } from "@spinejs/gateway-core";
import { toProvider } from "@spinejs/gateway-core";
import { validatePolicies, ThrottleConfigError } from "./policy-validation";
import { InMemoryThrottleStore } from "./memory-store";
import { ThrottleInterceptor } from "./interceptor";
import { validateRouteThrottleMeta } from "./engine";
import type { ResolvedThrottleConfig } from "./engine";
import type {
  Clock,
  KeySelector,
  LimitReachedEvent,
  ThrottleErrorEvent,
  ThrottlePolicy,
  ThrottleStore,
} from "./throttle.types";

/**
 * The minimal readonly view of a bound route the boot-time walk needs: only its opaque `meta` (the
 * `meta.throttle` namespace, AD-3). Both `HttpGateway.routes` and `ElectronIpcGateway.routes`
 * (readonly `LoadedRoute[]`) satisfy it structurally.
 */
export interface RouteSnapshot {
  meta?: unknown;
}

/**
 * A provider of a transport's readonly route snapshot (NFR-3, Story 2.2). Wire it to the gateway
 * whose `interceptors` slot holds this throttle instance — the module's start hook walks the routes
 * it returns and validates every `meta.throttle` spec, so a bad route-inline policy fails **boot**
 * (with the route/channel named) rather than the first dispatch:
 *
 *   ThrottleModule.configure({
 *     policies: { ... },
 *     routes: { inject: [HttpGateway], factory: (gw: HttpGateway) => () => gw.routes },
 *   })
 */
export type RouteSnapshotSource = () => readonly RouteSnapshot[];

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
  /**
   * Boot-time route-inline validation (NFR-3, Story 2.2): a provider yielding the gateway's
   * readonly route snapshot. The module's start hook walks it and validates every `meta.throttle`
   * spec with the same rules as `configure`-level validation, so a bad inline policy fails boot,
   * never the first dispatch. Omit it to keep the interim request-path guard only (see
   * {@link RouteSnapshotSource}).
   */
  routes?: ProviderAdapter<RouteSnapshotSource>;
}

// Internal per-instance tokens: each `configure()` returns a `fresh` module node providing its own
// values for them, so nothing leaks between named instances.
const storeToken = new InjectionToken<ThrottleStore>("throttle.store");
const ownsStoreToken = new InjectionToken<boolean>("throttle.owns-store");
const instanceNameToken = new InjectionToken<string>("throttle.instance-name");
const configToken = new InjectionToken<ResolvedThrottleConfig>(
  "throttle.config"
);
const routesSourceToken = new InjectionToken<RouteSnapshotSource>(
  "throttle.routes-source"
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
 *
 * Store lifecycle: the module disposes the default store it created on stop (releasing the
 * reclamation sweep). A store the app passed in stays the app's to dispose — it may outlive one
 * gateway (e.g. a shared Redis-backed store).
 */
@Module({
  inject: [
    storeToken,
    ownsStoreToken,
    instanceNameToken,
    configToken,
    routesSourceToken,
  ] as const,
})
export class ThrottleModule implements OnInit, OnStart, OnStop {
  constructor(
    private readonly store: ThrottleStore,
    private readonly ownsStore: boolean,
    private readonly instanceName: string,
    private readonly config: ResolvedThrottleConfig,
    private readonly routesSource: RouteSnapshotSource
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

  /**
   * Boot-time route-inline validation (NFR-3, Story 2.2). Runs after every module's `onInit` (so all
   * feature modules have registered their routes on the gateway), walks the wired transport route
   * snapshot and validates every `meta.throttle` spec with the SAME rules as `configure`-level
   * validation. An invalid inline spec (e.g. `'ip'` on IPC, a bad `limit`) fails the app start with
   * the route/channel named — reconciling the engine's interim request-path guard by catching it
   * pre-dispatch. No `routes` provider wired → an empty snapshot → the request-path guard stands.
   */
  onStart(): void {
    for (const route of this.routesSource()) {
      validateRouteThrottleMeta(
        route.meta,
        this.config.policies,
        this.config.keySources
      );
    }
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
        // The route-snapshot source drives the boot walk (NFR-3). Default: no snapshot wired → an
        // empty walk (the engine's request-path guard still fires). The app opts into boot-time
        // validation by wiring `routes` to its gateway (`() => gateway.routes`).
        toProvider(
          routesSourceToken,
          options.routes ?? { value: (): readonly RouteSnapshot[] => [] }
        ),
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
