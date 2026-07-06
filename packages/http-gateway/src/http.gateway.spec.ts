import { describe, expect, it } from "vitest";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  ChainInterceptor,
  GatewayContext,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import type { HttpRoute } from "./http.gateway";
import { get } from "./http-routes";
import type { HttpRouteMeta } from "./http-routes";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpBaseContext, HttpRaw } from "./http-base.types";

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};

function newGateway(): HttpGateway {
  return new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory
  );
}

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

@Controller({})
class UsersController {
  list = get("/users", {}, () => ({ ok: true }));
}

@Controller({})
class OrdersController {
  list = get("/orders", {}, () => ({ ok: true }));
}

describe("HttpGateway route retention (AD-4)", () => {
  it("accumulates routes across register() calls instead of overwriting", () => {
    const gw = newGateway();
    gw.register(getRoutes(new UsersController(), noGuards) as HttpRoute[]);
    gw.register(getRoutes(new OrdersController(), noGuards) as HttpRoute[]);

    // Both feature modules' routes survive — a later register() appends, never replaces.
    expect(gw.routes).toHaveLength(2);
    expect(gw.routes.map((r) => r.address.path)).toEqual(["/users", "/orders"]);
  });

  it("exposes the accumulated routes through the readonly accessor", () => {
    const gw = newGateway();
    expect(gw.routes).toHaveLength(0);
    gw.register(getRoutes(new UsersController(), noGuards) as HttpRoute[]);
    expect(gw.routes).toHaveLength(1);
  });
});

describe("failure envelope meta (FailureMeta seam)", () => {
  it("surfaces an interceptor's failure `meta` end-to-end in the HTTP response body", async () => {
    const rejecting: ChainInterceptor<HttpBaseContext, string, HttpRoute> = {
      intercept: async () => ({
        ok: false,
        code: "TOO_MANY_REQUESTS",
        meta: { retryAfterMs: 2000 },
      }),
    };
    const gw = new HttpGateway(
      new ZodValidator(),
      new DefaultHttpErrorMapper(),
      contextFactory,
      [rejecting]
    );
    gw.register(getRoutes(new UsersController(), noGuards) as HttpRoute[]);

    const res = await gw.app.request("/users");

    // 429 via the existing status map; the semantic meta rides the JSON envelope untouched.
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 2000 },
    });
  });
});

describe("route doc metadata carry (AD-13)", () => {
  it("surfaces optional doc fields on the marker meta", () => {
    @Controller({})
    class DocController {
      find = get(
        "/things/:id",
        {
          summary: "Find a thing",
          description: "Fetch one thing by id",
          tags: ["things"],
          operationId: "findThing",
          deprecated: true,
          examples: { ok: { value: { id: "1" } } },
          responses: { 404: { code: "NOT_FOUND" } },
          hidden: true,
        },
        () => ({ ok: true })
      );
    }

    const [route] = getRoutes(new DocController(), noGuards);
    const meta = route.meta as HttpRouteMeta;
    expect(meta.summary).toBe("Find a thing");
    expect(meta.description).toBe("Fetch one thing by id");
    expect(meta.tags).toEqual(["things"]);
    expect(meta.operationId).toBe("findThing");
    expect(meta.deprecated).toBe(true);
    expect(meta.examples).toEqual({ ok: { value: { id: "1" } } });
    expect(meta.responses).toEqual({ 404: { code: "NOT_FOUND" } });
    expect(meta.hidden).toBe(true);
  });

  it("omits doc fields from meta when the author provides none (NFR-4, clean meta)", () => {
    const [route] = getRoutes(new UsersController(), noGuards);
    const meta = route.meta as HttpRouteMeta;
    // Only-provided fields are carried — no `undefined`-valued keys pollute meta (stable downstream).
    expect(meta.summary).toBeUndefined();
    expect(meta.hidden).toBeUndefined();
    expect(Object.keys(meta)).not.toContain("summary");
    expect(Object.keys(meta)).not.toContain("hidden");
    expect(Object.keys(meta)).not.toContain("responses");
  });
});
