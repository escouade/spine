// The HTTP gateway module's boot walk (MetaValidator story): `onStart()` crosses the gateway's own
// routes × its `metaValidators` before `listen()`. A stub validator throwing on a specific route fails
// boot with that route named (`METHOD /path`); a passing validator lets onStart proceed. Routes are
// hand-built so their `meta` carries the stub's namespace directly (no battery augmentation needed).
import { describe, expect, it } from "vitest";
import type { MetaValidator } from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import type { HttpRoute } from "./http.gateway";
import { HttpGatewayModule } from "./http-gateway.module";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpBaseContext, HttpMethod, HttpRaw } from "./http-base.types";

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};

const route = (method: HttpMethod, path: string, meta: unknown): HttpRoute => ({
  address: { method, path },
  guards: [],
  invoke: () => 0,
  meta,
});

const newGateway = (routes: HttpRoute[]): HttpGateway => {
  const gw = new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory
  );
  gw.register(routes);
  return gw;
};

/** A validator that throws on the route whose id (`"METHOD /path"`) matches `throwOn`. */
const stub = (throwOn: string): MetaValidator & { seen: string[] } => {
  const seen: string[] = [];
  return {
    namespace: "probe",
    seen,
    validate(routeId) {
      seen.push(routeId);
      if (routeId === throwOn) throw new Error(`bad probe on ${routeId}`);
    },
  };
};

const twoRoutes = (): HttpRoute[] => [
  route("GET", "/ok", { probe: { any: true } }),
  route("POST", "/boom", { probe: { any: true } }),
];

describe("HttpGatewayModule boot walk (metaValidators slot)", () => {
  it("throws from onStart when a validator rejects a route — the route is named (METHOD /path)", () => {
    const gw = newGateway(twoRoutes());
    const validator = stub("POST /boom");
    // Constructor arg order mirrors the @Module inject list: (gateway, port, metaValidators).
    const mod = new HttpGatewayModule(gw, undefined, [validator]);

    expect(() => mod.onStart()).toThrow(/bad probe on POST \/boom/);
    // `probe` is on both routes, so the walk reaches /ok before /boom throws.
    expect(validator.seen).toContain("GET /ok");
  });

  it("proceeds through onStart when every validator passes (no port → no listen)", () => {
    const gw = newGateway(twoRoutes());
    const validator = stub("nothing-matches");
    const mod = new HttpGatewayModule(gw, undefined, [validator]);

    expect(() => mod.onStart()).not.toThrow();
    expect(validator.seen).toEqual(["GET /ok", "POST /boom"]);
  });

  it("only calls a validator for routes carrying its namespace (a route without it is skipped)", () => {
    const gw = newGateway([
      route("GET", "/probed", { probe: {} }),
      route("GET", "/plain", { other: {} }),
    ]);
    const validator = stub("no-throw");
    new HttpGatewayModule(gw, undefined, [validator]).onStart();
    expect(validator.seen).toEqual(["GET /probed"]);
  });

  it("does not walk when no validators are wired (empty slot → onStart is a no-op walk)", () => {
    const gw = newGateway(twoRoutes());
    const mod = new HttpGatewayModule(gw, undefined, []);
    expect(() => mod.onStart()).not.toThrow();
  });

  it("configure() accepts a `metaValidators` provider (additive, backward-compatible)", () => {
    const dm = HttpGatewayModule.configure({
      imports: [],
      contextFactory: { value: contextFactory },
      metaValidators: { value: [stub("none")] },
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
