// SSE connect enforcement (Design 4′). The throttle interceptor implements `ConnectInterceptor`, so
// the SAME instance placed in the gateway's `interceptors` is automatically run at SSE connect time:
// connection attempts count against the policies, a deny is a 429 envelope carrying `Retry-After` +
// `meta.retryAfterMs`, stream events are never counted, and the main `interceptors` array keeps its
// ADR-0017 no-SSE behavior for the streaming body. A request-only interceptor (no `interceptConnect`)
// is structurally excluded from the connect chain. `sse()` copies `throttle` verbatim + stamps routeId
// like the verb helpers.
import "./http"; // loads the http-gateway `throttle` augmentation (verb + sse options)
import { afterEach, describe, expect, it, vi } from "vitest";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  GatewayContext,
  GatewayInterceptor,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import {
  HttpGateway,
  ZodValidator,
  DefaultHttpErrorMapper,
  SseHub,
  get,
  sse,
} from "@spinejs/http-gateway";
import type {
  HttpAddress,
  HttpBaseContext,
  HttpRaw,
  HttpRoute,
} from "@spinejs/http-gateway";
import { ThrottleInterceptor } from "./interceptor";
import { InMemoryThrottleStore } from "./memory-store";
import { rateLimitHeaders } from "./http";
import { FakeClock } from "./testing";
import type { ResolvedThrottleConfig } from "./engine";
import type { ThrottleRouteMeta } from "./engine";

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};
const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

/** One throttle interceptor over a gateway-scoped policy (shared bucket across routes + connects). */
function throttleInterceptor(limit: number, clock = new FakeClock()) {
  const config: ResolvedThrottleConfig = {
    name: "sse",
    policies: {
      stream: {
        limit,
        windowMs: 1000,
        keyBy: () => "client-1",
        scope: "gateway",
      },
    },
    keySources: {},
    emitRawKey: false,
    onOutcome: rateLimitHeaders(), // writes RateLimit-* / Retry-After into the AD-8 header bag
  };
  return new ThrottleInterceptor(
    config,
    new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 })
  );
}

const streamRoutes = (hub: SseHub<string>): HttpRoute[] => {
  @Controller({})
  class StreamController {
    stream = sse("/stream", {}, () => hub.subscribe("k"));
  }
  return getRoutes<HttpBaseContext, HttpAddress>(
    new StreamController(),
    noGuards
  ) as HttpRoute[];
};

/** Drains + cancels an SSE response body so an accepted stream never leaks a subscription. */
async function closeStream(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

describe("SSE connect enforcement via ConnectInterceptor (Design 4′)", () => {
  const opened: Response[] = [];
  afterEach(async () => {
    for (const res of opened.splice(0)) await closeStream(res);
  });

  // Design 4′: the throttle interceptor is wired ONCE, in the main `interceptors` list. Because it
  // implements `ConnectInterceptor`, the gateway derives the connect chain from that same list.
  function gatewayWith(interceptor: ThrottleInterceptor, hub: SseHub<string>) {
    const gw = new HttpGateway(
      new ZodValidator(),
      new DefaultHttpErrorMapper(),
      contextFactory,
      [interceptor], // single list — connect chain is derived from it (no separate slot)
      undefined,
      0 // no heartbeat timer
    );
    gw.register(streamRoutes(hub));
    return gw;
  }

  it("allows connects under the limit (stream opens with RateLimit-* headers)", async () => {
    const hub = new SseHub<string>();
    const gw = gatewayWith(throttleInterceptor(2), hub);

    const res = await gw.app.request("/stream");
    opened.push(res);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The accepted connect's quota rode the AD-8 bag onto the stream-open response.
    expect(res.headers.get("ratelimit-limit")).toBe("2");
    expect(res.headers.get("ratelimit-remaining")).toBe("1");
  });

  it("denies a connect past the limit: 429 JSON with Retry-After + meta.retryAfterMs, no stream", async () => {
    const hub = new SseHub<string>();
    const gw = gatewayWith(throttleInterceptor(2), hub);

    opened.push(await gw.app.request("/stream"));
    opened.push(await gw.app.request("/stream"));
    const denied = await gw.app.request("/stream"); // limit + 1

    expect(denied.status).toBe(429);
    expect(denied.headers.get("content-type")).toContain("application/json");
    expect(denied.headers.get("retry-after")).toBe("1"); // ceil(1000ms / 1000)
    expect(await denied.json()).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 1000 },
    });
  });

  it("never counts stream events — only the connect consumes (AD-6)", async () => {
    const hub = new SseHub<string>();
    const gw = gatewayWith(throttleInterceptor(2), hub);

    const first = await gw.app.request("/stream"); // consumes 1
    opened.push(first);
    await vi.waitUntil(() => hub.subscriberCount("k") === 1, { timeout: 1000 });
    for (let i = 0; i < 5; i++) hub.publish("k", { event: "e", data: i }); // 5 events, uncounted

    // Exactly one more connect fits (limit 2) — proving the 5 events did NOT consume the bucket.
    opened.push(await gw.app.request("/stream"));
    const third = await gw.app.request("/stream");
    expect(third.status).toBe(429);
  });

  it("excludes a request-only interceptor from the connect chain (structural, Design 4′)", async () => {
    const hub = new SseHub<string>();
    let requestOnlyCalls = 0;
    // A plain `GatewayInterceptor` with NO `interceptConnect` — e.g. a request-scoped UoW. It must
    // never run at connect: the gateway filters the connect chain on `interceptConnect` presence, and
    // the SSE path bypasses the buffered `interceptors` pipeline entirely (ADR-0017).
    const requestOnly: GatewayInterceptor = {
      intercept: (_t, _c, _i, next) => {
        requestOnlyCalls += 1;
        return next();
      },
    };
    const gw = new HttpGateway(
      new ZodValidator(),
      new DefaultHttpErrorMapper(),
      contextFactory,
      [requestOnly, throttleInterceptor(5)], // one list: only the throttle interceptor is connect-capable
      undefined,
      0
    );
    gw.register(streamRoutes(hub));

    opened.push(await gw.app.request("/stream"));
    expect(requestOnlyCalls).toBe(0); // request-only interceptor never touched the connection
  });

  it("shares one engine + store across dispatch and connect from a single list (no double count)", async () => {
    const hub = new SseHub<string>();
    const interceptor = throttleInterceptor(2); // gateway-scoped limit 2
    const gw = new HttpGateway(
      new ZodValidator(),
      new DefaultHttpErrorMapper(),
      contextFactory,
      [interceptor], // ONE list — same instance enforces dispatch (request) and connect (SSE)
      undefined,
      0
    );
    @Controller({})
    class ApiController {
      ping = get("/ping", {}, () => "pong");
      stream = sse("/stream", {}, () => hub.subscribe("k"));
    }
    gw.register(
      getRoutes<HttpBaseContext, HttpAddress>(
        new ApiController(),
        noGuards
      ) as HttpRoute[]
    );

    const ping1 = await gw.app.request("/ping"); // consumes 1 (dispatch)
    expect(ping1.status).toBe(200);
    opened.push(await gw.app.request("/stream")); // consumes 2 (connect) — same bucket
    // The 3rd hit on the shared gateway bucket is denied on EITHER path (one store, no double count).
    const ping3 = await gw.app.request("/ping");
    expect(ping3.status).toBe(429);
    const stream3 = await gw.app.request("/stream");
    expect(stream3.status).toBe(429);
  });
});

describe("sse() copies throttle verbatim + stamps routeId (Story 2.3, AD-3)", () => {
  it("stamps meta.throttle = { ...fields, routeId: 'GET /path' }", () => {
    @Controller({})
    class C {
      s = sse(
        "/events",
        {
          throttle: {
            policies: [{ limit: 3, windowMs: 1000, keyBy: () => "k" }],
          },
        },
        () => new SseHub<string>().subscribe("k")
      );
    }
    const [route] = getRoutes<HttpBaseContext, HttpAddress>(new C(), noGuards);
    const throttle = (route.meta as { throttle?: ThrottleRouteMeta }).throttle;
    expect(throttle?.routeId).toBe("GET /events");
    expect(throttle?.policies).toHaveLength(1);
  });

  it("encodes `throttle: false` as disabled and rejects a non-plain-object value at build", () => {
    @Controller({})
    class C {
      s = sse("/off", { throttle: false }, () =>
        new SseHub<string>().subscribe("k")
      );
    }
    const [route] = getRoutes<HttpBaseContext, HttpAddress>(new C(), noGuards);
    expect(
      (route.meta as { throttle?: ThrottleRouteMeta }).throttle
    ).toMatchObject({ disabled: true, routeId: "GET /off" });

    expect(() =>
      sse("/x", { throttle: true as unknown as false }, () =>
        new SseHub<string>().subscribe("k")
      )
    ).toThrow(/`throttle` must be a throttle options object or `false`/);
  });
});
