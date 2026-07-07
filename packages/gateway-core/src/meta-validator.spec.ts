import { describe, expect, it, vi } from "vitest";
import { validateRouteMeta } from "./meta-validator";
import type { MetaValidator } from "./ports";

/** A validator recording every `(routeId, meta)` it is handed, optionally throwing on a chosen route. */
const recorder = (
  namespace: string,
  throwOn?: string
): MetaValidator & { calls: [string, unknown][] } => {
  const calls: [string, unknown][] = [];
  return {
    namespace,
    calls,
    validate(routeId, meta) {
      calls.push([routeId, meta]);
      if (throwOn !== undefined && routeId === throwOn) {
        throw new Error(`invalid ${namespace} on ${routeId}`);
      }
    },
  };
};

// The address model is arbitrary here — the walk is address-agnostic and takes an `addressToRouteId` fn.
const idOf = (address: string): string => address;

describe("validateRouteMeta (gateway boot walk)", () => {
  it("runs a validator ONLY for routes whose meta carries its namespace, passing the unwrapped slice", () => {
    const throttle = recorder("throttle");
    const routes = [
      { address: "GET /a", meta: { throttle: { limit: 1 } } },
      { address: "GET /b", meta: { other: { x: 1 } } }, // no `throttle` → skipped
      { address: "GET /c", meta: { throttle: { limit: 2 }, other: {} } },
    ];

    validateRouteMeta(routes, [throttle], idOf);

    // Only /a and /c carry `throttle`; each got the unwrapped `meta.throttle`, not the whole meta.
    expect(throttle.calls).toEqual([
      ["GET /a", { limit: 1 }],
      ["GET /c", { limit: 2 }],
    ]);
  });

  it("propagates a throwing validator with the offending route id (via addressToRouteId)", () => {
    const throttle = recorder("throttle", "POST /boom");
    const routes = [
      { address: "GET /ok", meta: { throttle: {} } },
      { address: "POST /boom", meta: { throttle: {} } },
    ];

    expect(() => validateRouteMeta(routes, [throttle], idOf)).toThrow(
      /invalid throttle on POST \/boom/
    );
  });

  it("does NOT walk at all when zero validators are wired (backward-compatible)", () => {
    // A route with meta that WOULD be invalid must not be inspected — no validators means no crossing.
    const badMeta = {
      get throttle(): never {
        throw new Error("meta must not be read when no validator is wired");
      },
    };
    expect(() =>
      validateRouteMeta([{ address: "GET /x", meta: badMeta }], [], idOf)
    ).not.toThrow();
  });

  it("skips a route whose meta is absent or a non-object (null / number / string)", () => {
    const throttle = recorder("throttle");
    const routes = [
      { address: "GET /none" }, // no meta
      { address: "GET /null", meta: null },
      { address: "GET /num", meta: 5 },
      { address: "GET /str", meta: "throttle" },
    ];
    validateRouteMeta(routes, [throttle], idOf);
    expect(throttle.calls).toHaveLength(0);
  });

  it("does NOT fire a validator whose namespace is a prototype-chain member (no own key on the meta)", () => {
    // `"toString"`/`"constructor"` live on `Object.prototype`; a bare `rec[ns]` would read truthy on
    // EVERY route and fire the validator against garbage. The own-property check keeps it inert.
    const proto = recorder("toString");
    validateRouteMeta(
      [{ address: "R1", meta: { throttle: {} } }], // no OWN `toString` key
      [proto],
      idOf
    );
    expect(proto.calls).toHaveLength(0);

    // But it DOES fire when the route carries `toString` as its own key (a real, if odd, namespace).
    const own = recorder("toString");
    validateRouteMeta(
      [{ address: "R2", meta: { toString: { x: 1 } } }],
      [own],
      idOf
    );
    expect(own.calls).toEqual([["R2", { x: 1 }]]);
  });

  it("treats a namespace key set to `undefined` as absent (not present-but-invalid)", () => {
    const throttle = recorder("throttle");
    validateRouteMeta(
      [{ address: "GET /u", meta: { throttle: undefined } }],
      [throttle],
      idOf
    );
    expect(throttle.calls).toHaveLength(0);
  });

  it("crosses every route against every validator (each namespace independent)", () => {
    const a = recorder("a");
    const b = recorder("b");
    const spyA = vi.spyOn(a, "validate");
    const routes = [
      { address: "R1", meta: { a: 1, b: 2 } },
      { address: "R2", meta: { a: 3 } },
    ];
    validateRouteMeta(routes, [a, b], idOf);
    expect(spyA).toHaveBeenCalledTimes(2);
    expect(b.calls).toEqual([["R1", 2]]);
  });
});
