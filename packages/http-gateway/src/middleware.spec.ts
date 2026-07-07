// The app-level middleware hook: `configure({ middleware })` mounts Hono middleware on `gateway.app`
// in the CONSTRUCTOR, before any route is bound — so a middleware wraps every route registered later,
// in array order, deterministically (not racing route registration in onStart). These tests build the
// gateway directly (middleware is the last ctor arg) and drive `gateway.app.request()`.
import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { HttpGateway } from "./http.gateway";
import type { HttpRoute } from "./http.gateway";
import { HttpGatewayModule } from "./http-gateway.module";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpBaseContext, HttpMethod, HttpRaw } from "./http-base.types";

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};

const route = (method: HttpMethod, path: string): HttpRoute => ({
  address: { method, path },
  guards: [],
  invoke: () => 0, // dispatch → { ok: true, data: 0 } → 200
  meta: undefined,
});

const build = (middleware: MiddlewareHandler[]): HttpGateway =>
  new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory,
    [], // interceptors
    undefined, // statusMapper
    undefined, // sseHeartbeatMs
    middleware
  );

describe("HttpGateway app-level middleware", () => {
  it("wraps a route registered AFTER construction (deterministic ordering)", async () => {
    // The core guarantee: middleware is mounted in the ctor, the route is bound later via register(),
    // yet Hono still applies the middleware — because it was registered first.
    const calls: string[] = [];
    const mw: MiddlewareHandler = async (_c, next) => {
      calls.push("mw");
      await next();
    };
    const gw = build([mw]);
    gw.register([route("GET", "/x")]);

    const res = await gw.app.request("/x");

    expect(res.status).toBe(200);
    expect(calls).toEqual(["mw"]);
  });

  it("runs multiple middleware outermost-first (array order)", async () => {
    const order: string[] = [];
    const mw1: MiddlewareHandler = async (_c, next) => {
      order.push("mw1-in");
      await next();
      order.push("mw1-out");
    };
    const mw2: MiddlewareHandler = async (_c, next) => {
      order.push("mw2-in");
      await next();
      order.push("mw2-out");
    };
    const gw = build([mw1, mw2]);
    gw.register([route("GET", "/x")]);

    await gw.app.request("/x");

    // First in the array is the outermost wrapper.
    expect(order).toEqual(["mw1-in", "mw2-in", "mw2-out", "mw1-out"]);
  });

  it("lets a middleware short-circuit before the route runs (CORS-preflight / auth-gate shape)", async () => {
    let handlerRan = false;
    const gate: MiddlewareHandler = async (c, next) => {
      if (c.req.header("x-block")) return c.json({ blocked: true }, 403);
      await next();
    };
    const gw = build([gate]);
    gw.register([
      {
        address: { method: "GET", path: "/x" },
        guards: [],
        invoke: () => {
          handlerRan = true;
          return 0;
        },
        meta: undefined,
      },
    ]);

    const blocked = await gw.app.request("/x", { headers: { "x-block": "1" } });
    expect(blocked.status).toBe(403);
    expect(handlerRan).toBe(false); // the route never ran — the middleware fully wraps it

    const ok = await gw.app.request("/x");
    expect(ok.status).toBe(200);
    expect(handlerRan).toBe(true);
  });

  it("defaults to no middleware (omitting the arg changes nothing)", async () => {
    const gw = build([]);
    gw.register([route("GET", "/x")]);
    const res = await gw.app.request("/x");
    expect(res.status).toBe(200);
  });

  it("configure() accepts a `middleware` provider (additive, backward-compatible)", () => {
    const passThrough: MiddlewareHandler = async (_c, next) => {
      await next();
    };
    const dm = HttpGatewayModule.configure({
      imports: [],
      contextFactory: { value: contextFactory },
      middleware: { value: [passThrough] },
    });
    expect(dm.module).toBe(HttpGatewayModule);
    // Omitting it still configures cleanly (default `[]`).
    expect(() =>
      HttpGatewayModule.configure({
        imports: [],
        contextFactory: { value: contextFactory },
      })
    ).not.toThrow();
  });
});
