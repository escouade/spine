// Story 2.1 — the battery side of the IPC route-option seam: with the `./electron-ipc` augmentation
// loaded, `throttle` is FULLY TYPED in `handle()` (the literals below typecheck with no cast), the
// helper stamps `routeId` = the channel, and the engine honours the stamped meta through real
// channels — full parity with the HTTP verb helpers (Story 1.8).
import "./electron-ipc"; // loads the `declare module "@spinejs/electron-ipc-gateway"` augmentation
import { describe, expect, it, vi } from "vitest";
import { Controller, DispatchPipeline, getRoutes } from "@spinejs/gateway-core";

// Importing `@spinejs/electron-ipc-gateway`'s index transitively loads `electron` (the gateway binds
// `ipcMain`). This spec never registers on a real gateway (it drives `DispatchPipeline` directly), so
// a bare `ipcMain` stub is enough to keep the module import from touching the electron binary.
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));

import type {
  Envelope,
  ErrorMapper,
  GatewayContext,
  Guard,
  GuardConstructor,
  Validator,
} from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import type { IpcRoute, IpcRouteMeta } from "@spinejs/electron-ipc-gateway";
import { ThrottleInterceptor } from "./interceptor";
import { InMemoryThrottleStore } from "./memory-store";
import { FakeClock } from "./testing";
import type { ThrottleRouteMeta } from "./engine";
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
  return new DispatchPipeline<GatewayContext, string, IpcRoute>(
    validator,
    errorMapper,
    [interceptor]
  );
}

const routesOf = (controller: object): IpcRoute[] =>
  getRoutes(controller, noGuards) as IpcRoute[];

const send = (
  pipeline: DispatchPipeline<GatewayContext, string, IpcRoute>,
  route: IpcRoute
): Promise<Envelope<unknown, string>> => pipeline.dispatch(route, {}, {});

describe("IPC route options through the real handle() helper (Story 2.1)", () => {
  it("enforces a fully-typed route-inline policy, scoped routeId#index (channel) and non-overridable", async () => {
    @Controller({})
    class EchoController {
      // Typed via the augmentation: no cast anywhere in this options literal.
      login = handle(
        "auth:login",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
          },
        },
        () => "ok"
      );
      other = handle(
        "auth:other",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
          },
        },
        () => "ok"
      );
      // Attempts to override the inline policy by its synthesized `routeId#index` id. Inline policies
      // are NON-overridable — `override` addresses only named gateway defaults — so this must NOT take.
      overrideAttempt = handle(
        "auth:override-attempt",
        {
          throttle: {
            policies: [{ limit: 1, windowMs: 60_000, keyBy: () => "victim" }],
            override: { "auth:override-attempt#0": { limit: 100 } },
          },
        },
        () => "ok"
      );
    }

    const pipeline = pipelineWith({});
    const [login, other, overrideAttempt] = routesOf(new EchoController());

    expect((await send(pipeline, login)).ok).toBe(true);
    const rejected = await send(pipeline, login);
    expect(rejected).toMatchObject({ ok: false, code: "TOO_MANY_REQUESTS" });
    // routeId#index scoping: the same inline policy on another channel has its own bucket.
    expect((await send(pipeline, other)).ok).toBe(true);
    // Non-overridable: naming the inline policy in `override` does NOT loosen it to 100.
    expect(await send(pipeline, overrideAttempt)).toMatchObject({
      ok: false,
      code: "INTERNAL",
    });
  });

  it("`skip: ['name']` disables only that named default for the channel", async () => {
    @Controller({})
    class ApiController {
      skipped = handle(
        "cmd:skipped",
        { throttle: { skip: ["global"] } },
        () => 0
      );
      normal = handle("cmd:normal", {}, () => 0);
    }

    const pipeline = pipelineWith({ global: policy() });
    const [skipped, normal] = routesOf(new ApiController());

    expect((await send(pipeline, skipped)).ok).toBe(true);
    expect((await send(pipeline, skipped)).ok).toBe(true);
    expect((await send(pipeline, normal)).ok).toBe(true);
    expect((await send(pipeline, normal)).ok).toBe(false);
  });

  it("`throttle: false` opts the channel out of all defaults", async () => {
    @Controller({})
    class HealthController {
      health = handle("cmd:health", { throttle: false }, () => "up");
    }

    const pipeline = pipelineWith({ global: policy() });
    const [health] = routesOf(new HealthController());
    for (let i = 0; i < 5; i++) {
      expect((await send(pipeline, health)).ok).toBe(true);
    }
  });

  it("`override` re-tunes a named default for that channel only", async () => {
    @Controller({})
    class MixedController {
      strict = handle(
        "cmd:strict",
        { throttle: { override: { global: { limit: 1 } } } },
        () => 0
      );
      relaxed = handle("cmd:relaxed", {}, () => 0);
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
    expect(() =>
      handle("cmd:x", { throttle: true as unknown as false }, () => 0)
    ).toThrow(/`throttle` must be a throttle options object or `false`/);
    expect(() =>
      handle("cmd:x", { throttle: [] as unknown as false }, () => 0)
    ).toThrow(/got an array/);
  });

  it("stamps routeId = channel and leaves existing handle() call sites unchanged (backward-compat)", () => {
    @Controller({})
    class LegacyController {
      // No `throttle` option — the pre-Epic-2 call shape must compile and behave unchanged.
      plain = handle("cmd:plain", {}, (input: unknown) => input);
    }
    const [plain] = routesOf(new LegacyController());
    const meta = plain.meta as IpcRouteMeta & { throttle?: ThrottleRouteMeta };
    // The marker is still a normal IPC marker (input/response carried), and every channel is stamped
    // with its `routeId` so route-scoped policies resolve per-channel (Story 2.2 boot walk relies on it).
    expect(meta.throttle?.routeId).toBe("cmd:plain");
    expect(plain.address).toBe("cmd:plain");
  });
});
