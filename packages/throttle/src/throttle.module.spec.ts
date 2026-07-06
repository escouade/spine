import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { ThrottleModule, throttleInterceptorRef } from "./throttle.module";
import { InMemoryThrottleStore } from "./memory-store";
import { ThrottleInterceptor } from "./interceptor";
import { ThrottleConfigError } from "./policy-validation";
import { validatePolicy } from "./policy-validation";
import type { ThrottlePolicy } from "./throttle.types";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const makeApp = (modules: ModuleEntry[]) =>
  new App(modules, { logger: silentLogger, handleProcessExit: false });

// App installs process-level error handlers at construction; snapshot + restore so a failing test
// cannot leave a handler that kills the vitest worker (mirrors core's app.spec).
const SIGNALS = [
  "uncaughtException",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
] as const;
let listenerSnapshot: Record<string, ((...args: unknown[]) => void)[]>;

beforeEach(() => {
  listenerSnapshot = {};
  for (const signal of SIGNALS) {
    listenerSnapshot[signal] = process
      .listeners(signal as NodeJS.Signals)
      .slice() as never;
  }
});
afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal as NodeJS.Signals)) {
      if (!listenerSnapshot[signal].includes(listener as never)) {
        process.removeListener(signal as NodeJS.Signals, listener as never);
      }
    }
  }
});

const policy = (overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy => ({
  limit: 5,
  windowMs: 1000,
  keyBy: () => "k",
  ...overrides,
});

describe("ThrottleModule.configure (Story 1.3)", () => {
  it("returns a fresh DynamicModule exposing the interceptor token", () => {
    const dm = ThrottleModule.configure({ policies: { global: policy() } });

    expect(dm.module).toBe(ThrottleModule);
    expect(dm.fresh).toBe(true);
    expect(dm.exports).toContain(throttleInterceptorRef());
  });

  it("memoizes the interceptor ref token per name (provider and injector agree)", () => {
    expect(throttleInterceptorRef()).toBe(throttleInterceptorRef("default"));
    expect(throttleInterceptorRef("api")).toBe(throttleInterceptorRef("api"));
    expect(throttleInterceptorRef("api")).not.toBe(throttleInterceptorRef());
  });

  it("resolves the interceptor through a real App boot (ProviderAdapter convention)", async () => {
    let captured: ThrottleInterceptor | undefined;

    @Module({
      inject: [throttleInterceptorRef()] as const,
      imports: [ThrottleModule.configure({ policies: { global: policy() } })],
    })
    class FeatureModule {
      constructor(interceptor: ThrottleInterceptor) {
        captured = interceptor;
      }
    }

    const app = makeApp([FeatureModule]);
    await app.init();
    try {
      expect(captured).toBeInstanceOf(ThrottleInterceptor);
      expect(captured?.config.policies.global.limit).toBe(5);
    } finally {
      await app.stop();
    }
  });

  it("gives two named configure() calls two isolated instances — config never merges (AD-7)", async () => {
    let api: ThrottleInterceptor | undefined;
    let admin: ThrottleInterceptor | undefined;

    @Module({
      inject: [
        throttleInterceptorRef("api"),
        throttleInterceptorRef("admin"),
      ] as const,
      imports: [
        ThrottleModule.configure({
          name: "api",
          policies: { global: policy({ limit: 100 }) },
        }),
        ThrottleModule.configure({
          name: "admin",
          policies: { strict: policy({ limit: 3 }) },
        }),
      ],
    })
    class TwoGatewaysModule {
      constructor(a: ThrottleInterceptor, b: ThrottleInterceptor) {
        api = a;
        admin = b;
      }
    }

    const app = makeApp([TwoGatewaysModule]);
    await app.init();
    try {
      expect(api).toBeInstanceOf(ThrottleInterceptor);
      expect(admin).toBeInstanceOf(ThrottleInterceptor);
      expect(api).not.toBe(admin);
      // Each instance carries exactly its own configuration.
      expect(Object.keys(api?.config.policies ?? {})).toEqual(["global"]);
      expect(api?.config.policies.global.limit).toBe(100);
      expect(Object.keys(admin?.config.policies ?? {})).toEqual(["strict"]);
      expect(admin?.config.policies.strict.limit).toBe(3);
    } finally {
      await app.stop();
    }
  });

  it("fails at boot when two instances reuse a name (AD-7 isolation enforced, not silent first-wins)", async () => {
    // A shared, timer-less store keeps the failed boot from leaking a sweep interval.
    const store = new InMemoryThrottleStore({ sweepIntervalMs: 0 });

    @Module({
      inject: [throttleInterceptorRef("dup")] as const,
      imports: [
        ThrottleModule.configure({
          name: "dup",
          policies: { a: policy() },
          store,
        }),
        ThrottleModule.configure({
          name: "dup",
          policies: { b: policy() },
          store,
        }),
      ],
    })
    class DupModule {
      constructor(_interceptor: ThrottleInterceptor) {}
    }

    const app = makeApp([DupModule]);
    await expect(app.init()).rejects.toThrow(ThrottleConfigError);
    // Tear down the instance that DID claim the name, so a later test can reuse "dup".
    await app.stop().catch(() => {});
    store.dispose();
  });
});

describe("store lifecycle (Story 1.5)", () => {
  it("disposes the owned default store (its unref'd sweep) when the app stops", async () => {
    const dispose = vi.spyOn(InMemoryThrottleStore.prototype, "dispose");

    @Module({
      inject: [throttleInterceptorRef("lifecycle")] as const,
      imports: [
        ThrottleModule.configure({
          name: "lifecycle",
          policies: { global: policy() },
        }),
      ],
    })
    class LifecycleModule {
      constructor(_interceptor: ThrottleInterceptor) {}
    }

    const app = makeApp([LifecycleModule]);
    await app.init();
    expect(dispose).not.toHaveBeenCalled();
    await app.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
    dispose.mockRestore();
  });

  it("leaves an app-provided store alone on stop (the app owns its lifecycle)", async () => {
    const custom = new InMemoryThrottleStore();
    const dispose = vi.spyOn(custom, "dispose");

    @Module({
      inject: [throttleInterceptorRef("custom-store")] as const,
      imports: [
        ThrottleModule.configure({
          name: "custom-store",
          policies: { global: policy() },
          store: custom,
        }),
      ],
    })
    class CustomStoreModule {
      constructor(_interceptor: ThrottleInterceptor) {}
    }

    const app = makeApp([CustomStoreModule]);
    await app.init();
    await app.stop();
    expect(dispose).not.toHaveBeenCalled();
    custom.dispose();
  });
});

describe("boot validation (NFR-3)", () => {
  const configureWith = (p: ThrottlePolicy) => () =>
    ThrottleModule.configure({ policies: { offender: p } });

  it("rejects a non-positive limit, naming the policy and the rule", () => {
    expect(configureWith(policy({ limit: 0 }))).toThrow(ThrottleConfigError);
    expect(configureWith(policy({ limit: 0 }))).toThrow(
      /"offender".*`limit` must be a positive integer/
    );
    expect(configureWith(policy({ limit: -1 }))).toThrow(ThrottleConfigError);
  });

  it("rejects a non-positive windowMs", () => {
    expect(configureWith(policy({ windowMs: 0 }))).toThrow(
      /"offender".*`windowMs` must be a positive number/
    );
    expect(configureWith(policy({ windowMs: -1 }))).toThrow(
      ThrottleConfigError
    );
  });

  it("rejects a non-finite windowMs (NaN/Infinity would break resetMs and Retry-After arithmetic)", () => {
    expect(configureWith(policy({ windowMs: Number.NaN }))).toThrow(
      /"offender".*`windowMs` must be a positive number/
    );
    expect(
      configureWith(policy({ windowMs: Number.POSITIVE_INFINITY }))
    ).toThrow(/"offender".*`windowMs` must be a positive number/);
    expect(configureWith(policy({ windowMs: Number.NaN }))).toThrow(
      ThrottleConfigError
    );
  });

  it("rejects a non-integer limit (a fractional slot count is a config bug)", () => {
    expect(configureWith(policy({ limit: 2.5 }))).toThrow(
      /"offender".*`limit` must be a positive integer/
    );
  });

  it("rejects a non-positive/non-integer maxKeys (NaN would disable the LRU bound)", () => {
    expect(configureWith(policy({ maxKeys: 0 }))).toThrow(
      /"offender".*`maxKeys` must be a positive integer/
    );
    expect(configureWith(policy({ maxKeys: 2.5 }))).toThrow(
      /"offender".*`maxKeys` must be a positive integer/
    );
    expect(configureWith(policy({ maxKeys: Number.NaN }))).toThrow(
      /"offender".*`maxKeys`/
    );
  });

  it("rejects a limit above the sanity ceiling (10 000)", () => {
    expect(configureWith(policy({ limit: 10_001 }))).toThrow(
      /"offender".*sanity ceiling of 10000/
    );
    // The ceiling itself is fine.
    expect(configureWith(policy({ limit: 10_000 }))).not.toThrow();
  });

  it("rejects a keyBy selector name with no wired key source", () => {
    expect(configureWith(policy({ keyBy: "ip" }))).toThrow(
      /"offender".*keyBy: 'ip'.*not wired/
    );
    // Wiring the source fixes it — 'identity' has no special casing either (FR-5).
    expect(() =>
      ThrottleModule.configure({
        policies: { offender: policy({ keyBy: "identity" }) },
        keySources: { identity: () => "user-1" },
      })
    ).not.toThrow();
  });

  it("rejects a policy name colliding with the route-inline identity namespace (`#`)", () => {
    expect(() =>
      ThrottleModule.configure({ policies: { "login#0": policy() } })
    ).toThrow(/"login#0".*must not contain `#`/);
  });

  it("accepts scope 'gateway' in configure but rejects it route-inline (AD-3)", () => {
    expect(configureWith(policy({ scope: "gateway" }))).not.toThrow();
    // Route-inline rule, shared with the Epic 2 boot walk of transport route snapshots.
    expect(() =>
      validatePolicy("login#0", policy({ scope: "gateway" }), {
        routeInline: true,
        keySources: [],
      })
    ).toThrow(/"login#0".*declarable only in `ThrottleModule.configure`/);
  });
});
