import { describe, expect, it } from "vitest";
import type {
  ConnectInterceptor,
  Envelope,
  GatewayInterceptor,
  RequestScoped,
} from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpBaseContext, HttpRaw } from "./http-base.types";

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};

const passThrough = async (
  _t: unknown,
  _c: unknown,
  _i: unknown,
  next: () => Promise<Envelope<unknown>>
) => next();

/** A request-scoped UoW that wrongly ALSO enforces at connect — the leak the boot-assert must catch. */
class LeakyUow
  implements GatewayInterceptor, ConnectInterceptor, RequestScoped
{
  readonly requestScoped = true;
  intercept = passThrough;
  interceptConnect = passThrough;
}

/** Connect-safe throttle-like: connect-capable, holds nothing per-request → no marker. */
class ThrottleLike implements GatewayInterceptor, ConnectInterceptor {
  intercept = passThrough;
  interceptConnect = passThrough;
}

/** A plain request-scoped UoW: marked, but does NOT run at connect. */
class SafeUow implements GatewayInterceptor, RequestScoped {
  readonly requestScoped = true;
  intercept = passThrough;
}

function build(interceptors: GatewayInterceptor[]): HttpGateway {
  return new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory,
    interceptors
  );
}

describe("HttpGateway connect-safety boot-assert (ADR 0024)", () => {
  it("throws at construction when a requestScoped interceptor is connect-capable", () => {
    // The gateway derives its SSE connect chain in the constructor — the guard runs there, so a
    // dangerous wiring fails boot, before any port is opened, never at the first stream.
    expect(() => build([new LeakyUow()])).toThrow(
      /LeakyUow is marked `requestScoped` but also implements ConnectInterceptor/
    );
  });

  it("constructs cleanly with a connect-capable interceptor that is not requestScoped (throttle)", () => {
    expect(() => build([new ThrottleLike()])).not.toThrow();
  });

  it("constructs cleanly with a requestScoped interceptor that is not connect-capable (a UoW)", () => {
    expect(() => build([new SafeUow()])).not.toThrow();
  });

  it("constructs cleanly with the two wired together (the intended throttle + UoW pairing)", () => {
    // The exact real-world wiring: throttle enforces at connect, the UoW never does. No false positive.
    expect(() => build([new ThrottleLike(), new SafeUow()])).not.toThrow();
  });
});
