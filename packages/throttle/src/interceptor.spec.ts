import { describe, expect, it, vi } from "vitest";
import { DispatchPipeline } from "@spinejs/gateway-core";
import type {
  Envelope,
  ErrorMapper,
  GatewayContext,
  LoadedRoute,
  Validator,
} from "@spinejs/gateway-core";
import { ThrottleInterceptor } from "./interceptor";
import type { ResolvedThrottleConfig } from "./engine";
import { InMemoryThrottleStore } from "./memory-store";
import { hashKey } from "./key-pipeline";
import { FakeClock } from "./testing";
import {
  readThrottleOutcome,
  type LimitReachedEvent,
  type ThrottlePolicy,
  type ThrottleStore,
} from "./throttle.types";
import type { ThrottleRouteMeta } from "./engine";

type Ctx = GatewayContext;

const passthroughValidator: Validator = {
  validate: (schema, input) => schema.parse(input),
};
const errorMapper: ErrorMapper = { toCode: () => "INTERNAL" };

const policy = (overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy => ({
  limit: 2,
  windowMs: 1000,
  keyBy: () => "client-1",
  ...overrides,
});

function makeInterceptor(
  policies: Record<string, ThrottlePolicy>,
  configOverrides: Partial<ResolvedThrottleConfig> = {},
  store: ThrottleStore = new InMemoryThrottleStore({
    clock: new FakeClock(),
    sweepIntervalMs: 0,
  })
): ThrottleInterceptor {
  return new ThrottleInterceptor(
    {
      name: "default",
      policies,
      keySources: {},
      emitRawKey: false,
      ...configOverrides,
    },
    store
  );
}

/** A store double recording every consume by policy id, delegating to a real memory store. */
function recordingStore(): {
  store: ThrottleStore;
  consumed: { key: string; id: string }[];
} {
  const inner = new InMemoryThrottleStore({
    clock: new FakeClock(),
    sweepIntervalMs: 0,
  });
  const consumed: { key: string; id: string }[] = [];
  const store: ThrottleStore = {
    consume(key, storePolicy) {
      consumed.push({ key, id: storePolicy.id });
      return inner.consume(key, storePolicy);
    },
  };
  return { store, consumed };
}

const route = (throttle?: Partial<ThrottleRouteMeta>): LoadedRoute<Ctx> => ({
  guards: [],
  invoke: () => "handled",
  meta: throttle ? { throttle: { routeId: "GET /r", ...throttle } } : {},
});

const dispatch = (
  interceptor: ThrottleInterceptor,
  target: LoadedRoute<Ctx> = route(),
  ctx: Ctx = {},
  rawInput: unknown = undefined
): Promise<Envelope<unknown, string>> =>
  new DispatchPipeline<Ctx, string, LoadedRoute<Ctx>>(
    passthroughValidator,
    errorMapper,
    [interceptor]
  ).dispatch(target, ctx, rawInput);

describe("ThrottleEngine composition (Story 1.7)", () => {
  it("rejects with TOO_MANY_REQUESTS + meta.retryAfterMs when any policy is exhausted", async () => {
    const interceptor = makeInterceptor({
      wide: policy({ limit: 10 }),
      tight: policy({ limit: 1 }),
    });

    expect((await dispatch(interceptor)).ok).toBe(true);
    const rejected = await dispatch(interceptor);
    expect(rejected).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 1000 },
    });
  });

  it("evaluates every applicable policy independently — no refund on the non-rejecting one", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      { wide: policy({ limit: 10 }), tight: policy({ limit: 1 }) },
      {},
      store
    );

    await dispatch(interceptor); // both consumed
    const rejected = await dispatch(interceptor); // tight rejects, wide STILL consumed
    expect(rejected.ok).toBe(false);
    expect(consumed.filter((c) => c.id === "wide")).toHaveLength(2);
    expect(consumed.filter((c) => c.id === "tight")).toHaveLength(2);
  });

  it("writes the outcome ctx symbol exactly once with the most-restrictive state", async () => {
    const interceptor = makeInterceptor({
      wide: policy({ limit: 10 }),
      tight: policy({ limit: 4 }),
    });

    const ctx: Ctx = {};
    await dispatch(interceptor, route(), ctx);
    // tight: 1 hit of 4 → remaining 3 < wide's 9.
    expect(readThrottleOutcome(ctx)).toEqual({
      policyName: "tight",
      limit: 4,
      remaining: 3,
      resetMs: 1000,
    });
  });

  it("tie-breaks equal remaining by soonest reset", async () => {
    const clock = new FakeClock();
    const store = new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 });
    const interceptor = makeInterceptor(
      { a: policy({ limit: 2, windowMs: 5000 }), b: policy({ limit: 2 }) },
      {},
      store
    );

    const ctx: Ctx = {};
    await dispatch(interceptor, route(), ctx);
    // Both remaining 1; b resets in 1000ms < a's 5000ms.
    expect(readThrottleOutcome(ctx)?.policyName).toBe("b");
    expect(readThrottleOutcome(ctx)?.resetMs).toBe(1000);
  });

  it("writes no outcome when no policy applied", async () => {
    const interceptor = makeInterceptor({
      skipped: policy({ keyBy: () => null }),
    });
    const ctx: Ctx = {};
    await dispatch(interceptor, route(), ctx);
    expect(readThrottleOutcome(ctx)).toBeUndefined();
  });

  it("notifies the outcome observer (AD-8 hook for the ./http translator)", async () => {
    const onOutcome = vi.fn();
    const interceptor = makeInterceptor({ p: policy() }, { onOutcome });
    const ctx: Ctx = {};
    await dispatch(interceptor, route(), ctx);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(ctx, readThrottleOutcome(ctx));
  });
});

describe("custom selectors (FR-6)", () => {
  it("receives ctx and the RAW pre-validation input", async () => {
    const keyBy = vi.fn(() => "k");
    const interceptor = makeInterceptor({ p: policy({ keyBy }) });
    const ctx: Ctx = {};
    const rawInput = { body: { email: " UPPER@x.y " } }; // deliberately un-normalized

    // The pipeline's validator would lowercase/trim — the selector sees the raw shape.
    await dispatch(
      interceptor,
      route({
        /* no inline policies */
      }),
      ctx,
      rawInput
    );
    expect(keyBy).toHaveBeenCalledTimes(1);
    expect(keyBy).toHaveBeenCalledWith(ctx, rawInput);
  });

  it("skips the policy when the selector returns null", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      { anon: policy({ keyBy: () => null }), real: policy({ limit: 10 }) },
      {},
      store
    );

    const envelope = await dispatch(interceptor);
    expect(envelope.ok).toBe(true);
    expect(consumed.map((c) => c.id)).toEqual(["real"]); // anon never consumed
  });

  it("fail-closed by default when the selector throws", async () => {
    const interceptor = makeInterceptor({
      broken: policy({
        keyBy: () => {
          throw new Error("selector boom");
        },
      }),
    });

    const envelope = await dispatch(interceptor);
    expect(envelope).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 1000 }, // conservative: the policy's window
    });
  });

  it("fails open per policy when failOpen is set — selector and store errors alike", async () => {
    const throwingSelector = policy({
      failOpen: true,
      keyBy: () => {
        throw new Error("selector boom");
      },
    });
    const failingStore: ThrottleStore = {
      consume: () => Promise.reject(new Error("store down")),
    };

    expect((await dispatch(makeInterceptor({ p: throwingSelector }))).ok).toBe(
      true
    );
    expect(
      (
        await dispatch(
          makeInterceptor({ p: policy({ failOpen: true }) }, {}, failingStore)
        )
      ).ok
    ).toBe(true);
  });

  it("fail-closed on store failure by default (FR-19)", async () => {
    const failingStore: ThrottleStore = {
      consume: () => Promise.reject(new Error("store down")),
    };
    const envelope = await dispatch(
      makeInterceptor({ p: policy() }, {}, failingStore)
    );
    expect(envelope.ok).toBe(false);
  });
});

describe("short-circuit and observability (FR-9, FR-14)", () => {
  it("runs no guard or validator for a rejected request (spy test)", async () => {
    const canActivate = vi.fn(() => true);
    const parse = vi.fn((input: unknown) => input);
    const invoke = vi.fn();
    const target: LoadedRoute<Ctx> = {
      guards: [{ canActivate }],
      input: { parse },
      invoke,
      meta: {},
    };
    const interceptor = makeInterceptor({ p: policy({ limit: 1 }) });

    await dispatch(interceptor, target); // consumes the single slot (guard+handler ran)
    canActivate.mockClear();
    parse.mockClear();
    invoke.mockClear();

    const rejected = await dispatch(interceptor, target);
    expect(rejected.ok).toBe(false);
    expect(canActivate).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fires onLimitReached with the hashed key (raw key only on explicit opt-in)", async () => {
    const events: LimitReachedEvent[] = [];
    const interceptor = makeInterceptor(
      { p: policy({ limit: 1, keyBy: () => "203.0.113.7" }) },
      { onLimitReached: (e) => events.push(e) }
    );

    await dispatch(interceptor, route({}));
    await dispatch(interceptor, route({}));
    expect(events).toEqual([
      {
        policyName: "p",
        routeId: "GET /r",
        keyHash: hashKey("203.0.113.7"),
        retryAfterMs: 1000,
      },
    ]);
    expect(events[0]).not.toHaveProperty("rawKey");

    const rawEvents: LimitReachedEvent[] = [];
    const optIn = makeInterceptor(
      { p: policy({ limit: 1, keyBy: () => "203.0.113.7" }) },
      { onLimitReached: (e) => rawEvents.push(e), emitRawKey: true }
    );
    await dispatch(optIn, route({}));
    await dispatch(optIn, route({}));
    expect(rawEvents[0].rawKey).toBe("203.0.113.7");
  });
});

describe("route spec semantics (AD-3 groundwork for Story 1.8)", () => {
  it("scopes route-inline policies as routeId#index", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor({}, {}, store);

    await dispatch(
      interceptor,
      route({ policies: [policy(), policy({ limit: 5 })] })
    );
    expect(consumed.map((c) => c.id)).toEqual(["GET /r#0", "GET /r#1"]);
  });

  it("keys route-scoped policies per route target, gateway-scoped ones across routes", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      {
        perRoute: policy(),
        global: policy({ scope: "gateway" }),
      },
      {},
      store
    );

    const routeA: LoadedRoute<Ctx> = {
      guards: [],
      invoke: () => 0,
      meta: { throttle: { routeId: "GET /a" } },
    };
    const routeB: LoadedRoute<Ctx> = {
      guards: [],
      invoke: () => 0,
      meta: { throttle: { routeId: "GET /b" } },
    };
    await dispatch(interceptor, routeA);
    await dispatch(interceptor, routeB);

    const keysOf = (id: string) =>
      consumed.filter((c) => c.id === id).map((c) => c.key);
    // Per-route policy: distinct buckets for A and B.
    expect(new Set(keysOf("perRoute")).size).toBe(2);
    // Gateway-scoped policy: ONE shared bucket.
    expect(new Set(keysOf("global")).size).toBe(1);
  });

  it("`throttle: false` (disabled) opts out of all defaults — nothing consumed, no outcome", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor({ p: policy({ limit: 1 }) }, {}, store);
    const ctx: Ctx = {};

    const envelope = await dispatch(
      interceptor,
      route({ disabled: true }),
      ctx
    );
    expect(envelope.ok).toBe(true);
    expect(consumed).toHaveLength(0);
    expect(readThrottleOutcome(ctx)).toBeUndefined();
  });

  it("`skip` disables only the named default for that route", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      { a: policy(), b: policy() },
      {},
      store
    );

    await dispatch(interceptor, route({ skip: ["a"] }));
    expect(consumed.map((c) => c.id)).toEqual(["b"]);
  });

  it("`override` re-tunes a named default for that route (merged values, route scope)", async () => {
    const interceptor = makeInterceptor({
      login: policy({ limit: 100 }),
    });

    const target = route({ override: { login: { limit: 1 } } });
    expect((await dispatch(interceptor, target)).ok).toBe(true);
    const rejected = await dispatch(interceptor, target);
    expect(rejected.ok).toBe(false); // the route-level limit 1 applied, not the default 100
  });

  it("rejects `scope: 'gateway'` on a route-inline policy (interim request-path guard until Story 2.2)", async () => {
    const interceptor = makeInterceptor({});
    const envelope = await dispatch(
      interceptor,
      route({ policies: [policy({ scope: "gateway" })] })
    );
    // The ThrottleConfigError escapes the interceptor; the pipeline maps it to an error envelope.
    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
  });
});
