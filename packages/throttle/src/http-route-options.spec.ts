// Story 1.8 — the battery side of the HTTP route-option seam: with the `./http` augmentation
// loaded, `throttle` is FULLY TYPED in the verb helpers (the literals below typecheck with no
// cast), and the engine honours the stamped meta through real routes.
import "./http"; // loads the `declare module "@spinejs/http-gateway"` augmentation
import { describe, expect, it } from "vitest";
import { Controller, DispatchPipeline, getRoutes } from "@spinejs/gateway-core";
import type {
  Envelope,
  ErrorMapper,
  GatewayContext,
  Guard,
  GuardConstructor,
  Validator,
} from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";
import type { HttpRoute } from "@spinejs/http-gateway";
import { ThrottleInterceptor } from "./interceptor";
import { InMemoryThrottleStore } from "./memory-store";
import { FakeClock } from "./testing";
import type { ThrottlePolicy } from "./throttle.types";

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();
const validator: Validator = {
  validate: (schema, input) => schema.parse(input),
};
const errorMapper: ErrorMapper = { toCode: () => "INTERNAL" };

const policy = (overrides: Partial<ThrottlePolicy> = {}): ThrottlePolicy => ({
  limit: 1,
  windowMs: 1000,
  keyBy: () => "client-1",
  ...overrides,
});

function pipelineWith(policies: Record<string, ThrottlePolicy>) {
  const interceptor = new ThrottleInterceptor(
    { name: "default", policies, keySources: {}, emitRawKey: false },
    new InMemoryThrottleStore({ clock: new FakeClock(), sweepIntervalMs: 0 })
  );
  return new DispatchPipeline<GatewayContext, string, HttpRoute>(
    validator,
    errorMapper,
    [interceptor]
  );
}

const routesOf = (controller: object): HttpRoute[] =>
  getRoutes(controller, noGuards) as HttpRoute[];

const send = (
  pipeline: DispatchPipeline<GatewayContext, string, HttpRoute>,
  route: HttpRoute
): Promise<Envelope<unknown, string>> => pipeline.dispatch(route, {}, {});

describe("HTTP route options through real verb helpers (Story 1.8)", () => {
  it("enforces a fully-typed route-inline policy, scoped routeId#index and non-overridable", async () => {
    @Controller({})
    class LoginController {
      // Typed via the augmentation: no cast anywhere in this options literal.
      login = post(
        "/login",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
          },
        },
        () => "ok"
      );
      other = post(
        "/other",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
          },
        },
        () => "ok"
      );
      // Attempts to override the inline policy by its synthesized `routeId#index` id. Inline policies
      // are NON-overridable — `override` addresses only named gateway defaults — so this must NOT take.
      overrideAttempt = post(
        "/override-attempt",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
            override: { "POST /override-attempt#0": { limit: 100 } },
          },
        },
        () => "ok"
      );
    }

    const pipeline = pipelineWith({});
    const [login, other, overrideAttempt] = routesOf(new LoginController());

    expect((await send(pipeline, login)).ok).toBe(true);
    const rejected = await send(pipeline, login);
    expect(rejected).toMatchObject({ ok: false, code: "TOO_MANY_REQUESTS" });
    // routeId#index scoping: the same inline policy on another route has its own bucket.
    expect((await send(pipeline, other)).ok).toBe(true);
    // Non-overridable: naming the inline policy in `override` does NOT loosen it to 100 — the framework
    // refuses the re-tune (the synthesized inline id is not an overridable gateway default).
    expect(await send(pipeline, overrideAttempt)).toMatchObject({
      ok: false,
      code: "INTERNAL",
    });
  });

  it("`skip: ['name']` disables only that named default for the route", async () => {
    @Controller({})
    class ApiController {
      skipped = get("/skipped", { throttle: { skip: ["global"] } }, () => 0);
      normal = get("/normal", {}, () => 0);
    }

    const pipeline = pipelineWith({ global: policy() });
    const [skipped, normal] = routesOf(new ApiController());

    // The skipped route never consumes: repeated calls all pass.
    expect((await send(pipeline, skipped)).ok).toBe(true);
    expect((await send(pipeline, skipped)).ok).toBe(true);
    // The normal route still enforces the default.
    expect((await send(pipeline, normal)).ok).toBe(true);
    expect((await send(pipeline, normal)).ok).toBe(false);
  });

  it("`throttle: false` opts the route out of all defaults", async () => {
    @Controller({})
    class HealthController {
      health = get("/health", { throttle: false }, () => "up");
    }

    const pipeline = pipelineWith({ global: policy() });
    const [health] = routesOf(new HealthController());
    for (let i = 0; i < 5; i++) {
      expect((await send(pipeline, health)).ok).toBe(true);
    }
  });

  it("`override` re-tunes a named default for that route only", async () => {
    @Controller({})
    class MixedController {
      strict = get(
        "/strict",
        { throttle: { override: { global: { limit: 1 } } } },
        () => 0
      );
      relaxed = get("/relaxed", {}, () => 0);
    }

    const pipeline = pipelineWith({ global: policy({ limit: 3 }) });
    const [strict, relaxed] = routesOf(new MixedController());

    expect((await send(pipeline, strict)).ok).toBe(true);
    expect((await send(pipeline, strict)).ok).toBe(false); // overridden limit 1
    expect((await send(pipeline, relaxed)).ok).toBe(true);
    expect((await send(pipeline, relaxed)).ok).toBe(true);
    expect((await send(pipeline, relaxed)).ok).toBe(true); // default limit 3 untouched
  });

  it('rejects a non-plain-object `throttle` value at build (true/"global"/array run with defaults otherwise)', () => {
    // `throttle: true` typechecks under plain JS (no augmentation) and would spread to nothing —
    // the helper must reject it rather than silently enforce defaults.
    expect(() =>
      post("/x", { throttle: true as unknown as false }, () => 0)
    ).toThrow(/`throttle` must be a throttle options object or `false`/);
    expect(() =>
      post("/x", { throttle: [] as unknown as false }, () => 0)
    ).toThrow(/got an array/);
  });

  it("scopes a route-less default per route target via the stamped routeId", async () => {
    @Controller({})
    class TwoRoutesController {
      a = get("/a", {}, () => 0);
      b = get("/b", {}, () => 0);
    }

    const pipeline = pipelineWith({ perRoute: policy({ limit: 1 }) });
    const [a, b] = routesOf(new TwoRoutesController());

    expect((await send(pipeline, a)).ok).toBe(true);
    expect((await send(pipeline, a)).ok).toBe(false); // /a exhausted…
    expect((await send(pipeline, b)).ok).toBe(true); // …but /b has its own bucket
  });
});
