import { describe, it, expect, vi } from "vitest";
import type { DispatchTarget, GatewayContext } from "./gateway.types";
import { DispatchPipeline } from "./pipeline";
import type { ErrorMapper, GatewayInterceptor, Validator } from "./ports";
import { UnauthorizedError, ValidationError } from "./ports";

type Ctx = GatewayContext;

const passthroughValidator: Validator = {
  validate: (schema, input) => schema.parse(input),
};

/** Maps known pipeline errors to stable codes, anything else to INTERNAL. */
const errorMapper: ErrorMapper = {
  toCode: (err) =>
    err instanceof UnauthorizedError
      ? "UNAUTHORIZED"
      : err instanceof ValidationError
      ? "INVALID_INPUT"
      : "INTERNAL",
};

const target = (
  overrides: Partial<DispatchTarget<Ctx>> = {}
): DispatchTarget<Ctx> => ({
  guards: [],
  invoke: () => "result",
  ...overrides,
});

const pipeline = (interceptors: GatewayInterceptor[] = []) =>
  new DispatchPipeline(passthroughValidator, errorMapper, interceptors);

describe("DispatchPipeline", () => {
  it("invokes the handler and wraps its result in an ok envelope", async () => {
    const envelope = await pipeline().dispatch(target(), {}, undefined);

    expect(envelope).toEqual({ ok: true, data: "result" });
  });

  it("runs guards before the handler and maps a rejection to UNAUTHORIZED", async () => {
    const invoke = vi.fn();
    const envelope = await pipeline().dispatch(
      target({ guards: [{ canActivate: () => false }], invoke }),
      {},
      undefined
    );

    expect(envelope).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops at the first rejecting guard", async () => {
    const second = vi.fn(() => true);
    await pipeline().dispatch(
      target({
        guards: [{ canActivate: async () => false }, { canActivate: second }],
      }),
      {},
      undefined
    );

    expect(second).not.toHaveBeenCalled();
  });

  it("validates the raw input and passes the parsed value to the handler", async () => {
    const invoke = vi.fn((_ctx: Ctx, input: unknown) => input);
    const envelope = await pipeline().dispatch(
      target({ input: { parse: () => "parsed" }, invoke }),
      {},
      "raw"
    );

    expect(invoke).toHaveBeenCalledWith({}, "parsed");
    expect(envelope).toEqual({ ok: true, data: "parsed" });
  });

  it("passes the raw input through when the target has no schema", async () => {
    const invoke = vi.fn((_ctx: Ctx, input: unknown) => input);
    await pipeline().dispatch(target({ invoke }), {}, "raw");

    expect(invoke).toHaveBeenCalledWith({}, "raw");
  });

  it("maps a validation failure to its stable code", async () => {
    const envelope = await pipeline().dispatch(
      target({
        input: {
          parse: () => {
            throw new ValidationError();
          },
        },
      }),
      {},
      "raw"
    );

    expect(envelope).toEqual({ ok: false, code: "INVALID_INPUT" });
  });

  it("maps a throwing handler to an error envelope", async () => {
    const envelope = await pipeline().dispatch(
      target({
        invoke: () => {
          throw new Error("boom");
        },
      }),
      {},
      undefined
    );

    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
  });

  it("wraps interceptors in registration order, first registered outermost", async () => {
    const calls: string[] = [];
    const tracer = (name: string): GatewayInterceptor => ({
      intercept: async (_t, _c, _i, next) => {
        calls.push(`${name}:in`);
        const envelope = await next();
        calls.push(`${name}:out`);
        return envelope;
      },
    });

    await pipeline([tracer("first"), tracer("second")]).dispatch(
      target(),
      {},
      undefined
    );

    expect(calls).toEqual(["first:in", "second:in", "second:out", "first:out"]);
  });

  it("maps an interceptor throwing before next() to an error envelope instead of throwing", async () => {
    const throwing: GatewayInterceptor = {
      intercept: () => {
        throw new Error("interceptor boom");
      },
    };

    const envelope = await pipeline([throwing]).dispatch(
      target(),
      {},
      undefined
    );

    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
  });

  it("maps an interceptor throwing after next() to an error envelope", async () => {
    const throwingAfter: GatewayInterceptor = {
      intercept: async (_t, _c, _i, next) => {
        await next();
        throw new UnauthorizedError();
      },
    };

    const envelope = await pipeline([throwingAfter]).dispatch(
      target(),
      {},
      undefined
    );

    expect(envelope).toEqual({ ok: false, code: "UNAUTHORIZED" });
  });

  it("maps an async interceptor rejection to an error envelope", async () => {
    const rejecting: GatewayInterceptor = {
      intercept: () => Promise.reject(new Error("async boom")),
    };

    const envelope = await pipeline([rejecting]).dispatch(
      target(),
      {},
      undefined
    );

    expect(envelope).toEqual({ ok: false, code: "INTERNAL" });
  });
});
