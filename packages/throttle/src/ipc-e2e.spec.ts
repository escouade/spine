// Story 1.10 — IPC design-validation gate (UC-4): the SAME transport-agnostic interceptor drops
// into a real ElectronIpcGateway with a default policy only (no route options needed), keyed by the
// `'sender'` source. Renderer-side view asserted on the raw envelope (code + retryAfterMs), with
// the electron module mocked (the shared harness pattern from electron-ipc-gateway/testing).
import { describe, expect, it, vi } from "vitest";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  GatewayContext,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import type { Logger } from "@spinejs/core";
import {
  ElectronIpcGateway,
  ZodValidator,
  DefaultErrorMapper,
  handle,
} from "@spinejs/electron-ipc-gateway";
import type { IpcRoute } from "@spinejs/electron-ipc-gateway";
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import { ThrottleModule, throttleInterceptorRef } from "./throttle.module";
import { ThrottleInterceptor } from "./interceptor";
import { InMemoryThrottleStore } from "./memory-store";
import { ThrottleConfigError } from "./policy-validation";
import { senderKeySource } from "./electron-ipc";
import { FakeClock } from "./testing";

// Local `electron` mock keeping the RAW listeners (invoked with a custom sender-bearing event).
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => Promise<unknown>
    ) => handlers.set(channel, listener),
  },
}));

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

interface IpcHarness {
  clock: FakeClock;
  handlerCalls: () => number;
  invoke: (
    senderId: number,
    payload?: unknown
  ) => Promise<
    | { ok: true; data: unknown }
    | { ok: false; code: string; meta?: { retryAfterMs?: number } }
  >;
}

/** Boots a real ElectronIpcGateway with the throttle interceptor and one echo channel. */
function bootIpc(): IpcHarness {
  const clock = new FakeClock();
  let calls = 0;

  @Controller({})
  class EchoController {
    echo = handle("cmd:echo", {}, (input: unknown) => {
      calls += 1;
      return input;
    });
  }

  const interceptor = new ThrottleInterceptor(
    {
      name: "ipc",
      policies: {
        perSender: { limit: 3, windowMs: 1000, keyBy: "sender" },
      },
      keySources: { sender: senderKeySource() },
      emitRawKey: false,
    },
    new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 })
  );
  const gw = new ElectronIpcGateway(
    new ZodValidator(),
    new DefaultErrorMapper(),
    {
      create: (raw: ElectronIpcRaw): ElectronIpcBaseContext => ({
        event: raw.event,
      }),
    },
    silentLogger,
    [interceptor] // outermost (and only) interceptor
  );
  gw.register(getRoutes(new EchoController(), noGuards) as IpcRoute[]);

  const listener = handlers.get("cmd:echo");
  if (!listener) throw new Error('No IPC handler bound for "cmd:echo".');
  return {
    clock,
    handlerCalls: () => calls,
    invoke: (senderId, payload = { n: 1 }) =>
      listener({ sender: { id: senderId } }, payload) as never,
  };
}

describe("IPC design-validation gate (Story 1.10, UC-4)", () => {
  it("rejects past the limit with { ok: false, code: TOO_MANY_REQUESTS, meta.retryAfterMs } and never invokes the handler", async () => {
    const { invoke, handlerCalls } = bootIpc();

    for (let i = 0; i < 3; i++) {
      expect((await invoke(1)).ok).toBe(true);
    }
    expect(handlerCalls()).toBe(3);

    const rejected = await invoke(1); // limit + 1, same cold window
    expect(rejected).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 1000 },
    });
    // The main-process handler was NOT invoked for the rejected call.
    expect(handlerCalls()).toBe(3);
  });

  it("keys per renderer: another sender is untouched", async () => {
    const { invoke } = bootIpc();
    for (let i = 0; i < 3; i++) await invoke(1);
    expect((await invoke(1)).ok).toBe(false);
    expect((await invoke(2)).ok).toBe(true); // sender 2 has its own bucket
  });

  it("reports exact retry timing from the injected clock and recovers after it elapses (NFR-5)", async () => {
    const { invoke, clock } = bootIpc();
    for (let i = 0; i < 3; i++) await invoke(1); // t=0
    clock.tick(400);
    const rejected = await invoke(1);
    expect(rejected).toMatchObject({ meta: { retryAfterMs: 600 } }); // oldest + 1000 − 400
    clock.tick(600); // exactly retryAfterMs later
    expect((await invoke(1)).ok).toBe(true);
  });

  it("replays a fixed sequence identically (NFR-5 determinism)", async () => {
    const run = async (): Promise<boolean[]> => {
      const { invoke, clock } = bootIpc();
      const trace: boolean[] = [];
      for (const step of [0, 100, 100, 100, 100, 700]) {
        clock.tick(step);
        trace.push((await invoke(1)).ok);
      }
      return trace;
    };
    expect(await run()).toEqual(await run());
  });

  it("fails at boot on the IPC transport for a selector with no wired source ('ip' on IPC, NFR-3)", () => {
    expect(() =>
      ThrottleModule.configure({
        name: "ipc-misconfigured",
        policies: { global: { limit: 10, windowMs: 1000, keyBy: "ip" } },
        keySources: { sender: senderKeySource() },
      })
    ).toThrow(ThrottleConfigError);
    expect(() =>
      ThrottleModule.configure({
        name: "ipc-misconfigured",
        policies: { global: { limit: 10, windowMs: 1000, keyBy: "ip" } },
        keySources: { sender: senderKeySource() },
      })
    ).toThrow(/keyBy: 'ip'.*not wired.*'sender'/);
  });

  it("exposes the interceptor by DI token exactly like the HTTP side (one module, both transports)", () => {
    const dm = ThrottleModule.configure({
      name: "ipc-di",
      policies: { perSender: { limit: 3, windowMs: 1000, keyBy: "sender" } },
      keySources: { sender: senderKeySource() },
    });
    expect(dm.exports).toContain(throttleInterceptorRef("ipc-di"));
  });
});
