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
import { ThrottleConfigError } from "./policy-validation";
import { InMemoryThrottleStore } from "./memory-store";
import { hashKey } from "./key-pipeline";
import { FakeClock } from "./testing";
import { z } from "zod";
import {
  readThrottleOutcome,
  type LimitReachedEvent,
  type ThrottleErrorEvent,
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

// Every real route helper stamps a `routeId` (AD-3); default to a stamped one so route-scoped
// defaults resolve to a concrete bucket. Unstamped targets are exercised explicitly via `bareTarget`.
const route = (
  throttle: Partial<ThrottleRouteMeta> = {}
): LoadedRoute<Ctx> => ({
  guards: [],
  invoke: () => "handled",
  meta: { throttle: { routeId: "GET /r", ...throttle } },
});

/** A hand-built target with NO stamped `meta.throttle.routeId` (the unstamped/legacy case). */
const bareTarget = (): LoadedRoute<Ctx> => ({
  guards: [],
  invoke: () => "handled",
  meta: {},
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

/**
 * Dispatches through an errorMapper that CAPTURES the thrown error, so a boot/config rejection can be
 * proven to be a {@link ThrottleConfigError} — not merely the blanket `INTERNAL` code the shared
 * mapper collapses every error to (which a stray NPE would also produce).
 */
async function dispatchCapturingError(
  interceptor: ThrottleInterceptor,
  target: LoadedRoute<Ctx> = route(),
  ctx: Ctx = {}
): Promise<{ envelope: Envelope<unknown, string>; error: unknown }> {
  let error: unknown;
  const capturing: ErrorMapper = {
    toCode: (err) => {
      error = err;
      return "INTERNAL";
    },
  };
  const envelope = await new DispatchPipeline<Ctx, string, LoadedRoute<Ctx>>(
    passthroughValidator,
    capturing,
    [interceptor]
  ).dispatch(target, ctx, undefined);
  return { envelope, error };
}

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
    // AD-8: the observer receives the ctx and reads the outcome slot itself (no outcome argument).
    expect(onOutcome).toHaveBeenCalledWith(ctx);
    expect(readThrottleOutcome(ctx)).toBeDefined();
  });

  it("reports Retry-After as the LATEST reset over all rejecting policies, not the soonest", async () => {
    // Two policies exhausted at once: a short window (200ms) and a long one (5000ms), same key.
    const interceptor = makeInterceptor({
      short: policy({ limit: 1, windowMs: 200 }),
      long: policy({ limit: 1, windowMs: 5000 }),
    });

    expect((await dispatch(interceptor)).ok).toBe(true); // both accept their single slot
    const rejected = await dispatch(interceptor); // both reject
    // Retrying at 200ms would still hit `long` — the client must be told the latest, 5000ms.
    expect(rejected).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 5000 },
    });
  });

  it("a throwing onOutcome/onLimitReached observer never breaks enforcement", async () => {
    const onOutcome = () => {
      throw new Error("observer boom");
    };
    const onLimitReached = () => {
      throw new Error("observer boom");
    };
    const interceptor = makeInterceptor(
      { p: policy({ limit: 1 }) },
      { onOutcome, onLimitReached }
    );

    // Accept path still returns ok despite a throwing onOutcome.
    expect((await dispatch(interceptor)).ok).toBe(true);
    // Reject path still returns the 429 despite both observers throwing.
    expect((await dispatch(interceptor)).ok).toBe(false);
  });
});

describe("fail-closed telemetry (FR-14, onError)", () => {
  it("fires onError on a throwing selector and on a store outage (both fail-closed and fail-open)", async () => {
    const selectorErrors: ThrottleErrorEvent[] = [];
    const closed = makeInterceptor(
      {
        broken: policy({
          keyBy: () => {
            throw new Error("selector boom");
          },
        }),
      },
      { onError: (e) => selectorErrors.push(e) }
    );
    expect((await dispatch(closed)).ok).toBe(false); // fail-closed rejection…
    expect(selectorErrors).toHaveLength(1); // …still surfaced telemetry
    expect(selectorErrors[0]).toMatchObject({
      policyName: "broken",
      routeId: "GET /r",
      phase: "selector",
    });

    const storeErrors: ThrottleErrorEvent[] = [];
    const failingStore: ThrottleStore = {
      consume: () => Promise.reject(new Error("store down")),
    };
    const openStore = makeInterceptor(
      { p: policy({ failOpen: true }) },
      { onError: (e) => storeErrors.push(e) },
      failingStore
    );
    expect((await dispatch(openStore)).ok).toBe(true); // fail-open passes…
    expect(storeErrors[0]).toMatchObject({ phase: "store", policyName: "p" }); // …still telemetered
  });
});

describe("selector return-value handling (FR-6 edge cases)", () => {
  it("treats an undefined selector return as a null-skip (not a permanent fail-closed)", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      {
        skip: policy({ keyBy: () => undefined as unknown as string }),
        real: policy({ limit: 10 }),
      },
      {},
      store
    );
    const envelope = await dispatch(interceptor);
    expect(envelope.ok).toBe(true);
    expect(consumed.map((c) => c.id)).toEqual(["real"]); // `skip` opted out, never consumed
  });

  it("fail-closes with onError on a non-string selector return", async () => {
    const errors: ThrottleErrorEvent[] = [];
    const interceptor = makeInterceptor(
      { bad: policy({ keyBy: () => 42 as unknown as string }) },
      { onError: (e) => errors.push(e) }
    );
    expect((await dispatch(interceptor)).ok).toBe(false);
    expect(errors[0]).toMatchObject({ phase: "selector", policyName: "bad" });
  });
});

describe("unstamped-target guard (AD-3/AD-7)", () => {
  it("fails loud when a route-scoped policy hits a target with no stamped routeId", async () => {
    const interceptor = makeInterceptor({ perRoute: policy() }); // route-scoped default
    const { envelope, error } = await dispatchCapturingError(
      interceptor,
      bareTarget()
    );
    // The ThrottleConfigError escapes the interceptor; the pipeline maps it to an error envelope…
    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
    // …and it is specifically a config error (the unstamped-target guard), not an incidental throw.
    expect(error).toBeInstanceOf(ThrottleConfigError);
    expect((error as Error).message).toMatch(/no stamped `routeId`/);
  });

  it("allows a gateway-scoped policy on an unstamped target (shared bucket is intended)", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      { global: policy({ scope: "gateway" }) },
      {},
      store
    );
    expect((await dispatch(interceptor, bareTarget())).ok).toBe(true);
    expect(consumed.map((c) => c.id)).toEqual(["global"]);
  });
});

describe("custom selectors (FR-6)", () => {
  it("receives ctx and the RAW, un-normalized input — the selector runs before the transforming validator", async () => {
    // A schema that ACTUALLY transforms (trim + lowercase): post-validation differs from the raw
    // input, so "the selector saw the raw value" becomes falsifiable. Move selection after validation
    // and this test goes red — pinning the security property (bruteforce keys on un-normalized input).
    const seenByKeyBy: unknown[] = [];
    const keyBy = vi.fn((_ctx: Ctx, raw: unknown) => {
      seenByKeyBy.push(raw);
      return String((raw as { body?: { email?: string } })?.body?.email ?? "k");
    });
    let seenByHandler: unknown;
    const interceptor = makeInterceptor({ p: policy({ keyBy, limit: 10 }) });

    const target: LoadedRoute<Ctx> = {
      guards: [],
      input: z.object({
        body: z.object({ email: z.string().trim().toLowerCase() }),
      }),
      invoke: (_ctx: Ctx, validated: unknown) => {
        seenByHandler = validated;
        return "handled";
      },
      meta: { throttle: { routeId: "POST /login" } },
    };
    const ctx: Ctx = {};
    const rawInput = { body: { email: "  UPPER@X.Y  " } }; // deliberately un-normalized

    const envelope = await dispatch(interceptor, target, ctx, rawInput);
    expect(envelope.ok).toBe(true);
    // The selector saw the UNTRANSFORMED raw value…
    expect(keyBy).toHaveBeenCalledTimes(1);
    expect(keyBy).toHaveBeenCalledWith(ctx, rawInput);
    expect(seenByKeyBy[0]).toEqual({ body: { email: "  UPPER@X.Y  " } });
    // …while the handler (post-validation) received the normalized value — proving the transform is
    // real and happens strictly AFTER selection.
    expect(seenByHandler).toEqual({ body: { email: "upper@x.y" } });
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
      meta: { throttle: { routeId: "GET /guarded" } },
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
    const { envelope, error } = await dispatchCapturingError(
      interceptor,
      route({ policies: [policy({ scope: "gateway" })] })
    );
    // The ThrottleConfigError escapes the interceptor; the pipeline maps it to an error envelope…
    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
    // …and it is the config-error type, not an incidental throw the blanket INTERNAL would also hide.
    expect(error).toBeInstanceOf(ThrottleConfigError);
  });

  it("rejects an `override` that would re-scope a gateway-scoped default to route (AD-3)", async () => {
    const interceptor = makeInterceptor({
      global: policy({ scope: "gateway" }),
    });
    const { envelope, error } = await dispatchCapturingError(
      interceptor,
      route({ override: { global: { limit: 1 } } })
    );
    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
    expect(error).toBeInstanceOf(ThrottleConfigError);
  });

  it("validates the MERGED override values (an override of limit:0 fails, not NaN Retry-After)", async () => {
    const interceptor = makeInterceptor({ login: policy({ limit: 100 }) });
    const { envelope, error } = await dispatchCapturingError(
      interceptor,
      route({ override: { login: { limit: 0 } } })
    );
    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
    expect(error).toBeInstanceOf(ThrottleConfigError);
  });

  it("rejects `skip`/`override` naming a policy that is not a configured default", async () => {
    const interceptor = makeInterceptor({ real: policy() });
    const skipResult = await dispatchCapturingError(
      interceptor,
      route({ skip: ["typo"] })
    );
    expect(skipResult.envelope).toEqual({ ok: false, code: "INTERNAL" });
    expect(skipResult.error).toBeInstanceOf(ThrottleConfigError);

    const overrideResult = await dispatchCapturingError(
      interceptor,
      route({ override: { typo: { limit: 1 } } })
    );
    expect(overrideResult.envelope).toEqual({ ok: false, code: "INTERNAL" });
    expect(overrideResult.error).toBeInstanceOf(ThrottleConfigError);
  });

  it("gives an overridden default its OWN store space so a per-route maxKeys can't shrink the shared space", async () => {
    const { store, consumed } = recordingStore();
    const interceptor = makeInterceptor(
      { global: policy({ limit: 5 }) },
      {},
      store
    );

    const overridden: LoadedRoute<Ctx> = {
      guards: [],
      invoke: () => 0,
      meta: {
        throttle: { routeId: "GET /a", override: { global: { maxKeys: 2 } } },
      },
    };
    const plain: LoadedRoute<Ctx> = {
      guards: [],
      invoke: () => 0,
      meta: { throttle: { routeId: "GET /b" } },
    };
    await dispatch(interceptor, overridden);
    await dispatch(interceptor, plain);

    const idOf = (routeId: string) =>
      consumed.find((c) => c.key.startsWith(`${routeId}:`))?.id;
    // The overridden route counts under its own space id; the plain route under the base name.
    expect(idOf("GET /a")).toBe("global@GET /a");
    expect(idOf("GET /b")).toBe("global");
  });
});

describe("malformed hand-built inline meta at request time (review #40)", () => {
  it("rejects a null `policies` entry with ThrottleConfigError, not a raw TypeError", async () => {
    const interceptor = makeInterceptor({});
    const malformed = {
      guards: [],
      invoke: () => "handled",
      meta: { throttle: { routeId: "GET /r", policies: [null] } },
    } as unknown as LoadedRoute<Ctx>;
    // Proves the REQUEST path (dispatch → intercept → evaluate → parseSpec → validate) fails loud —
    // the boot walk is not the only guard site, and both share `validateRouteThrottleMeta` (review #40).
    const { error } = await dispatchCapturingError(interceptor, malformed);
    expect(error).toBeInstanceOf(ThrottleConfigError);
  });
});
