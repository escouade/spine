// Story 2.4 — full IPC e2e (FR-13 done-boundary). Per-channel route-inline policies (Story 2.1,
// stamped `routeId` = channel) enforced through a real ElectronIpcGateway, keyed by `'sender'`:
//  - a renderer exceeding a channel's limit gets { code, meta.retryAfterMs } and the handler is NOT
//    invoked,
//  - per-channel buckets are isolated (channel A's limit does not affect channel B),
//  - a backoff loop honoring retryAfterMs recovers deterministically under an injected clock.
import "./electron-ipc"; // loads the `throttle` augmentation for `handle()`
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
import type {
  IpcRoute,
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import { ThrottleInterceptor } from "./interceptor";
import { InMemoryThrottleStore } from "./memory-store";
import { senderKeySource } from "./electron-ipc";
import { FakeClock } from "./testing";

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

type IpcEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; code: string; meta?: { retryAfterMs?: number } };

interface FullHarness {
  clock: FakeClock;
  callsOf: (channel: "cmd:a" | "cmd:b") => number;
  invoke: (
    channel: "cmd:a" | "cmd:b",
    senderId: number
  ) => Promise<IpcEnvelope>;
}

/** Two channels with per-channel route-inline policies (A: limit 2, B: limit 5), keyed by sender. */
function bootFullIpc(): FullHarness {
  const clock = new FakeClock();
  const calls = { "cmd:a": 0, "cmd:b": 0 };

  @Controller({})
  class ApiController {
    a = handle(
      "cmd:a",
      {
        throttle: { policies: [{ limit: 2, windowMs: 1000, keyBy: "sender" }] },
      },
      (input: unknown) => {
        calls["cmd:a"] += 1;
        return input;
      }
    );
    b = handle(
      "cmd:b",
      {
        throttle: { policies: [{ limit: 5, windowMs: 1000, keyBy: "sender" }] },
      },
      (input: unknown) => {
        calls["cmd:b"] += 1;
        return input;
      }
    );
  }

  const interceptor = new ThrottleInterceptor(
    {
      name: "ipc-full",
      policies: {}, // no gateway defaults — protection is per-channel (route-inline)
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
    [interceptor]
  );
  gw.register(getRoutes(new ApiController(), noGuards) as IpcRoute[]);

  const invoke = (channel: "cmd:a" | "cmd:b", senderId: number) => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error(`No IPC handler bound for "${channel}".`);
    return listener(
      { sender: { id: senderId } },
      { n: 1 }
    ) as Promise<IpcEnvelope>;
  };
  return { clock, callsOf: (c) => calls[c], invoke };
}

describe("full IPC e2e with per-channel policies (Story 2.4, FR-13)", () => {
  it("surfaces code + retryAfterMs past a channel limit and never invokes the handler", async () => {
    const { invoke, callsOf } = bootFullIpc();

    expect((await invoke("cmd:a", 1)).ok).toBe(true);
    expect((await invoke("cmd:a", 1)).ok).toBe(true);
    expect(callsOf("cmd:a")).toBe(2);

    const rejected = await invoke("cmd:a", 1); // limit + 1, cold window
    expect(rejected).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 1000 },
    });
    // The main-process handler was NOT invoked for the rejected call.
    expect(callsOf("cmd:a")).toBe(2);
  });

  it("isolates per-channel buckets: channel A's limit does not affect channel B", async () => {
    const { invoke, callsOf } = bootFullIpc();

    // Exhaust channel A (limit 2) for sender 1.
    await invoke("cmd:a", 1);
    await invoke("cmd:a", 1);
    expect((await invoke("cmd:a", 1)).ok).toBe(false);

    // Channel B (limit 5) has its OWN bucket — untouched by A's exhaustion.
    for (let i = 0; i < 5; i++)
      expect((await invoke("cmd:b", 1)).ok).toBe(true);
    expect((await invoke("cmd:b", 1)).ok).toBe(false); // B's own limit reached independently
    expect(callsOf("cmd:b")).toBe(5);
  });

  it("keys per renderer: another sender has its own per-channel bucket", async () => {
    const { invoke } = bootFullIpc();
    await invoke("cmd:a", 1);
    await invoke("cmd:a", 1);
    expect((await invoke("cmd:a", 1)).ok).toBe(false); // sender 1 exhausted on A
    expect((await invoke("cmd:a", 2)).ok).toBe(true); // sender 2 fresh on A
  });

  it("a backoff loop honoring retryAfterMs recovers deterministically (injected clock)", async () => {
    const { invoke, clock } = bootFullIpc();

    // Drive channel A to rejection, then follow the advertised retryAfterMs to recover.
    await invoke("cmd:a", 1);
    await invoke("cmd:a", 1);

    let res = await invoke("cmd:a", 1);
    let attempts = 0;
    while (!res.ok && attempts < 5) {
      attempts += 1;
      const wait = res.ok ? 0 : res.meta?.retryAfterMs ?? 0;
      clock.tick(wait); // honor the server's backoff hint exactly
      res = await invoke("cmd:a", 1);
    }
    expect(res.ok).toBe(true); // recovered by honoring retryAfterMs
    expect(attempts).toBe(1); // one backoff step of exactly retryAfterMs was enough
  });

  it("replays a fixed per-channel sequence identically (NFR-5 determinism)", async () => {
    const run = async (): Promise<boolean[]> => {
      const { invoke, clock } = bootFullIpc();
      const trace: boolean[] = [];
      for (const step of [0, 100, 100, 100, 700, 100]) {
        clock.tick(step);
        trace.push((await invoke("cmd:a", 1)).ok);
      }
      return trace;
    };
    expect(await run()).toEqual(await run());
  });
});
