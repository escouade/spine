import { describe, expect, it } from "vitest";
import {
  assertConnectInterceptorsSafe,
  isConnectInterceptor,
} from "./connect-safety";
import type {
  ConnectInterceptor,
  Envelope,
  GatewayInterceptor,
  RequestScoped,
} from "./ports";

/** Connect-safe: enforces at connect (throttle-like), holds nothing per-request → no `requestScoped`. */
class ThrottleLike implements GatewayInterceptor, ConnectInterceptor {
  async intercept(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
  async interceptConnect(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
}

/** Request-scoped and connect-safe: a UoW that does NOT run at connect (no `interceptConnect`). */
class SafeUow implements GatewayInterceptor, RequestScoped {
  readonly requestScoped = true;
  async intercept(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
}

/** The dangerous combination the guard exists to reject: request-scoped AND connect-capable. */
class LeakyUow
  implements GatewayInterceptor, ConnectInterceptor, RequestScoped
{
  readonly requestScoped = true;
  async intercept(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
  async interceptConnect(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
}

/** The inheritance hole (ADR 0022 §Consequences): a request-scoped subclass of a connect-capable base. */
class ConnectableBase implements GatewayInterceptor, ConnectInterceptor {
  async intercept(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
  async interceptConnect(
    _t: unknown,
    _c: unknown,
    _i: unknown,
    next: () => Promise<Envelope<unknown>>
  ) {
    return next();
  }
}
class InheritedLeak extends ConnectableBase implements RequestScoped {
  readonly requestScoped = true; // inherits interceptConnect from the base → both signals present
}

describe("isConnectInterceptor", () => {
  it("is true when interceptConnect is a method (own or inherited), false otherwise", () => {
    expect(isConnectInterceptor(new ThrottleLike())).toBe(true);
    expect(isConnectInterceptor(new InheritedLeak())).toBe(true); // inherited from the base
    expect(isConnectInterceptor(new SafeUow())).toBe(false);
  });

  it("is false when interceptConnect exists but is not a function", () => {
    // A non-callable `interceptConnect` is not a connect opt-in — the derived chain would never call it.
    const notAMethod = {
      interceptConnect: true,
      async intercept(
        _t: unknown,
        _c: unknown,
        _i: unknown,
        next: () => Promise<Envelope<unknown>>
      ) {
        return next();
      },
    } as unknown as GatewayInterceptor;
    expect(isConnectInterceptor(notAMethod)).toBe(false);
  });
});

describe("assertConnectInterceptorsSafe (boot guard)", () => {
  it("throws, naming the interceptor, when a requestScoped interceptor is also connect-capable", () => {
    expect(() => assertConnectInterceptorsSafe([new LeakyUow()])).toThrow(
      /LeakyUow is marked `requestScoped` but also implements ConnectInterceptor/
    );
  });

  it("throws for the inheritance case (interceptConnect inherited from a connect-capable base)", () => {
    expect(() => assertConnectInterceptorsSafe([new InheritedLeak()])).toThrow(
      /InheritedLeak is marked `requestScoped`/
    );
  });

  it("does NOT throw for a connect-capable interceptor that is not requestScoped (throttle)", () => {
    expect(() =>
      assertConnectInterceptorsSafe([new ThrottleLike()])
    ).not.toThrow();
  });

  it("does NOT throw for a requestScoped interceptor that is not connect-capable (a UoW)", () => {
    expect(() => assertConnectInterceptorsSafe([new SafeUow()])).not.toThrow();
  });

  it("does NOT throw on an empty list, and ignores null/undefined slots", () => {
    expect(() => assertConnectInterceptorsSafe([])).not.toThrow();
    expect(() =>
      assertConnectInterceptorsSafe([null, undefined])
    ).not.toThrow();
  });

  it("still flags the offender when it sits alongside safe interceptors and a null slot", () => {
    // The scan is per-element; a preceding safe/null entry must not mask a later dangerous one.
    expect(() =>
      assertConnectInterceptorsSafe([
        new ThrottleLike(),
        null,
        new SafeUow(),
        new LeakyUow(),
      ])
    ).toThrow(/LeakyUow/);
  });

  it("names a dangerous object-literal interceptor generically (constructor.name === 'Object')", () => {
    // A plain object (not a class instance) reports `constructor.name === "Object"`; the message must
    // not read "Object is marked ...", it falls back to the generic phrasing. Exercises the name fallback.
    const literal = {
      requestScoped: true,
      async intercept(
        _t: unknown,
        _c: unknown,
        _i: unknown,
        next: () => Promise<Envelope<unknown>>
      ) {
        return next();
      },
      async interceptConnect(
        _t: unknown,
        _c: unknown,
        _i: unknown,
        next: () => Promise<Envelope<unknown>>
      ) {
        return next();
      },
    };
    expect(() => assertConnectInterceptorsSafe([literal])).toThrow(
      /an interceptor is marked `requestScoped`/
    );
  });

  it("does NOT flag a truthy-but-non-true requestScoped value (marker is the literal true)", () => {
    // The `RequestScoped` type pins `requestScoped: true`; a stray truthy value is not the marker and
    // the guard is strict `=== true`, so it neither false-positives here nor silently downgrades.
    const oddValue = {
      requestScoped: 1,
      async intercept(
        _t: unknown,
        _c: unknown,
        _i: unknown,
        next: () => Promise<Envelope<unknown>>
      ) {
        return next();
      },
      async interceptConnect(
        _t: unknown,
        _c: unknown,
        _i: unknown,
        next: () => Promise<Envelope<unknown>>
      ) {
        return next();
      },
    } as unknown;
    expect(() => assertConnectInterceptorsSafe([oddValue])).not.toThrow();
  });
});
